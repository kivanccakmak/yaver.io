package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

func runVault(args []string) {
	if len(args) == 0 {
		printVaultUsage()
		os.Exit(0)
	}

	switch args[0] {
	case "add":
		runVaultAdd(args[1:])
	case "list", "ls":
		runVaultList()
	case "get":
		runVaultGet(args[1:])
	case "delete", "rm":
		runVaultDelete(args[1:])
	case "export":
		runVaultExport()
	case "import":
		runVaultImport(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown vault subcommand: %s\n", args[0])
		printVaultUsage()
		os.Exit(1)
	}
}

func printVaultUsage() {
	fmt.Print(`Usage:
  yaver vault add <name> [--category <cat>] [--value <val>] [--notes <text>]
  yaver vault list                List all vault entries (names only)
  yaver vault get <name>          Get a vault entry value
  yaver vault delete <name>       Delete a vault entry
  yaver vault export              Export vault as plaintext JSON (use with caution)
  yaver vault import <file.json>  Import entries from plaintext JSON

Categories: api-key, signing-key, ssh-key, git-credential, custom

The vault is encrypted at rest (NaCl secretbox + Argon2id).
By default, it unlocks using your auth token. Override with:
  YAVER_VAULT_PASSPHRASE=<passphrase> yaver vault ...
`)
}

// openVault loads the vault using auth token or custom passphrase.
func openVault() *VaultStore {
	passphrase := os.Getenv("YAVER_VAULT_PASSPHRASE")
	if passphrase == "" {
		cfg, err := LoadConfig()
		if err != nil || cfg.AuthToken == "" {
			fmt.Fprintf(os.Stderr, "Not authenticated. Run 'yaver auth' first.\n")
			os.Exit(1)
		}
		passphrase = DerivePassphraseFromToken(cfg.AuthToken)
	}

	vs, err := NewVaultStore(passphrase)
	if err != nil {
		if strings.Contains(err.Error(), "wrong passphrase") {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			fmt.Fprintf(os.Stderr, "If you changed your auth token, set YAVER_VAULT_PASSPHRASE to your previous passphrase.\n")
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Error opening vault: %v\n", err)
		os.Exit(1)
	}
	return vs
}

func runVaultAdd(args []string) {
	fs := flag.NewFlagSet("vault add", flag.ExitOnError)
	category := fs.String("category", "api-key", "Entry category (api-key, signing-key, ssh-key, git-credential, custom)")
	value := fs.String("value", "", "Secret value (prompted if not provided)")
	notes := fs.String("notes", "", "Optional notes")

	// Reorder args: flags before positional
	var reordered, positional []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			reordered = append(reordered, args[i])
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				reordered = append(reordered, args[i+1])
				i++
			}
		} else {
			positional = append(positional, args[i])
		}
	}
	reordered = append(reordered, positional...)
	fs.Parse(reordered)

	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver vault add <name> [--category <cat>] [--value <val>]")
		os.Exit(1)
	}
	name := fs.Arg(0)

	secretValue := *value
	if secretValue == "" {
		fmt.Printf("Enter value for %q: ", name)
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			secretValue = scanner.Text()
		}
		if secretValue == "" {
			fmt.Fprintln(os.Stderr, "Error: value cannot be empty")
			os.Exit(1)
		}
	}

	vs := openVault()
	if err := vs.Set(VaultEntry{
		Name:     name,
		Category: *category,
		Value:    secretValue,
		Notes:    *notes,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Saved %q to vault.\n", name)
}

func runVaultList() {
	vs := openVault()
	entries := vs.List()

	if len(entries) == 0 {
		fmt.Println("Vault is empty. Add entries with 'yaver vault add <name>'.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tCATEGORY\tUPDATED")
	for _, e := range entries {
		t := time.UnixMilli(e.UpdatedAt)
		fmt.Fprintf(w, "%s\t%s\t%s\n", e.Name, e.Category, t.Format("2006-01-02 15:04"))
	}
	w.Flush()
}

func runVaultGet(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver vault get <name>")
		os.Exit(1)
	}
	name := args[0]

	vs := openVault()
	entry, err := vs.Get(name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Print(entry.Value)
	// Add newline if stdout is a terminal
	if fi, _ := os.Stdout.Stat(); fi != nil && fi.Mode()&os.ModeCharDevice != 0 {
		fmt.Println()
	}
}

func runVaultDelete(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver vault delete <name>")
		os.Exit(1)
	}
	name := args[0]

	vs := openVault()
	if err := vs.Delete(name); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Deleted %q from vault.\n", name)
}

func runVaultExport() {
	vs := openVault()
	data, err := vs.ExportPlaintext()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Warn if stdout is a terminal
	if fi, _ := os.Stdout.Stat(); fi != nil && fi.Mode()&os.ModeCharDevice != 0 {
		fmt.Fprintln(os.Stderr, "WARNING: Exporting vault as plaintext. Pipe to a file:")
		fmt.Fprintln(os.Stderr, "  yaver vault export > vault-backup.json")
		fmt.Fprintln(os.Stderr, "")
	}

	fmt.Println(string(data))
}

func runVaultImport(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver vault import <file.json>")
		os.Exit(1)
	}

	data, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading file: %v\n", err)
		os.Exit(1)
	}

	// Validate JSON
	var entries []json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		fmt.Fprintf(os.Stderr, "Error: file must contain a JSON array of vault entries\n")
		os.Exit(1)
	}

	vs := openVault()
	count, err := vs.ImportPlaintext(data)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Imported %d entries into vault.\n", count)
}
