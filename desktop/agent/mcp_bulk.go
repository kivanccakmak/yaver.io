package main

import (
	"encoding/json"
	"fmt"
	osexec "os/exec"
	"os"
)

// BulkTool defines a CLI-wrapping MCP tool via data, not code.
type BulkTool struct {
	Name        string
	Description string
	Command     string   // Base command (e.g. "systemctl")
	Args        []string // Default args
	Properties  map[string]map[string]interface{}
	Required    []string
	WorkDir     bool // Use directory property as working dir
}

// bulkTools is the registry of all data-driven tools.
var bulkTools = []BulkTool{
	// =========================================================================
	// LINUX SYSADMIN
	// =========================================================================
	{Name: "systemctl_status", Description: "Show systemd service status.", Command: "systemctl", Args: []string{"status"}, Properties: map[string]map[string]interface{}{"service": {"type": "string", "description": "Service name"}}, Required: []string{"service"}},
	{Name: "systemctl_start", Description: "Start a systemd service.", Command: "sudo", Args: []string{"systemctl", "start"}, Properties: map[string]map[string]interface{}{"service": {"type": "string"}}, Required: []string{"service"}},
	{Name: "systemctl_stop", Description: "Stop a systemd service.", Command: "sudo", Args: []string{"systemctl", "stop"}, Properties: map[string]map[string]interface{}{"service": {"type": "string"}}, Required: []string{"service"}},
	{Name: "systemctl_restart", Description: "Restart a systemd service.", Command: "sudo", Args: []string{"systemctl", "restart"}, Properties: map[string]map[string]interface{}{"service": {"type": "string"}}, Required: []string{"service"}},
	{Name: "systemctl_enable", Description: "Enable a systemd service.", Command: "sudo", Args: []string{"systemctl", "enable"}, Properties: map[string]map[string]interface{}{"service": {"type": "string"}}, Required: []string{"service"}},
	{Name: "systemctl_disable", Description: "Disable a systemd service.", Command: "sudo", Args: []string{"systemctl", "disable"}, Properties: map[string]map[string]interface{}{"service": {"type": "string"}}, Required: []string{"service"}},
	{Name: "systemctl_list", Description: "List all systemd services.", Command: "systemctl", Args: []string{"list-units", "--type=service", "--no-pager"}},
	{Name: "systemctl_failed", Description: "List failed systemd services.", Command: "systemctl", Args: []string{"--failed", "--no-pager"}},
	{Name: "journalctl_unit", Description: "Show logs for a systemd unit.", Command: "journalctl", Args: []string{"-u", "", "--no-pager", "-n", "100"}, Properties: map[string]map[string]interface{}{"unit": {"type": "string", "description": "Unit name"}}, Required: []string{"unit"}},
	{Name: "journalctl_boot", Description: "Show logs from current boot.", Command: "journalctl", Args: []string{"-b", "--no-pager", "-n", "200"}},
	{Name: "journalctl_errors", Description: "Show error-level log entries.", Command: "journalctl", Args: []string{"-p", "err", "--no-pager", "-n", "100"}},

	// Firewall
	{Name: "ufw_status", Description: "Show UFW firewall status and rules.", Command: "sudo", Args: []string{"ufw", "status", "verbose"}},
	{Name: "ufw_allow", Description: "Allow a port through UFW.", Command: "sudo", Args: []string{"ufw", "allow"}, Properties: map[string]map[string]interface{}{"port": {"type": "string", "description": "Port/service (e.g. 80, 443/tcp, ssh)"}}, Required: []string{"port"}},
	{Name: "ufw_deny", Description: "Deny a port in UFW.", Command: "sudo", Args: []string{"ufw", "deny"}, Properties: map[string]map[string]interface{}{"port": {"type": "string"}}, Required: []string{"port"}},
	{Name: "iptables_list", Description: "List iptables rules.", Command: "sudo", Args: []string{"iptables", "-L", "-n", "-v"}},

	// Users & permissions
	{Name: "users_list", Description: "List system users.", Command: "cat", Args: []string{"/etc/passwd"}},
	{Name: "groups_list", Description: "List system groups.", Command: "cat", Args: []string{"/etc/group"}},
	{Name: "whoami", Description: "Show current user.", Command: "whoami"},
	{Name: "id_info", Description: "Show user ID and group info.", Command: "id"},
	{Name: "last_logins", Description: "Show recent login history.", Command: "last", Args: []string{"-20"}},
	{Name: "w_users", Description: "Show who is logged in.", Command: "w"},

	// System info
	{Name: "uname_info", Description: "Show system/kernel info.", Command: "uname", Args: []string{"-a"}},
	{Name: "hostname_info", Description: "Show hostname.", Command: "hostname"},
	{Name: "lsb_release", Description: "Show Linux distribution info.", Command: "lsb_release", Args: []string{"-a"}},
	{Name: "free_mem", Description: "Show memory usage.", Command: "free", Args: []string{"-h"}},
	{Name: "vmstat", Description: "Show virtual memory stats.", Command: "vmstat", Args: []string{"1", "5"}},
	{Name: "iostat", Description: "Show I/O statistics.", Command: "iostat"},
	{Name: "lscpu", Description: "Show CPU info.", Command: "lscpu"},
	{Name: "lsblk", Description: "List block devices.", Command: "lsblk"},
	{Name: "lspci", Description: "List PCI devices.", Command: "lspci"},
	{Name: "lsusb", Description: "List USB devices.", Command: "lsusb"},
	{Name: "dmesg_recent", Description: "Show recent kernel messages.", Command: "dmesg", Args: []string{"--time-format=reltime", "-T"}},
	{Name: "top_snapshot", Description: "Show top processes snapshot.", Command: "top", Args: []string{"-b", "-n", "1"}},
	{Name: "load_average", Description: "Show system load average.", Command: "cat", Args: []string{"/proc/loadavg"}},
	{Name: "cpu_temp", Description: "Show CPU temperature.", Command: "sensors"},

	// Disk
	{Name: "df_all", Description: "Show disk space usage for all filesystems.", Command: "df", Args: []string{"-h"}},
	{Name: "du_summary", Description: "Show disk usage of current directory.", Command: "du", Args: []string{"-sh", "./*"}},
	{Name: "mount_list", Description: "List mounted filesystems.", Command: "mount"},
	{Name: "fdisk_list", Description: "List disk partitions.", Command: "sudo", Args: []string{"fdisk", "-l"}},

	// Network
	{Name: "ip_addr", Description: "Show network interfaces and IP addresses.", Command: "ip", Args: []string{"addr", "show"}},
	{Name: "ip_route", Description: "Show routing table.", Command: "ip", Args: []string{"route", "show"}},
	{Name: "ip_link", Description: "Show network link status.", Command: "ip", Args: []string{"link", "show"}},
	{Name: "ss_listen", Description: "Show listening ports.", Command: "ss", Args: []string{"-tlnp"}},
	{Name: "ss_all", Description: "Show all network connections.", Command: "ss", Args: []string{"-tunap"}},
	{Name: "netstat_listen", Description: "Show listening ports (netstat).", Command: "netstat", Args: []string{"-tlnp"}},
	{Name: "arp_table", Description: "Show ARP table.", Command: "arp", Args: []string{"-a"}},
	{Name: "traceroute", Description: "Trace route to host.", Command: "traceroute", Properties: map[string]map[string]interface{}{"host": {"type": "string"}}, Required: []string{"host"}},
	{Name: "mtr_report", Description: "Network diagnostic (MTR).", Command: "mtr", Args: []string{"--report", "-c", "5"}, Properties: map[string]map[string]interface{}{"host": {"type": "string"}}, Required: []string{"host"}},
	{Name: "dig_full", Description: "Full DNS lookup with dig.", Command: "dig", Properties: map[string]map[string]interface{}{"domain": {"type": "string"}}, Required: []string{"domain"}},
	{Name: "host_lookup", Description: "Simple DNS lookup.", Command: "host", Properties: map[string]map[string]interface{}{"domain": {"type": "string"}}, Required: []string{"domain"}},
	{Name: "nslookup_full", Description: "Full DNS lookup.", Command: "nslookup", Properties: map[string]map[string]interface{}{"domain": {"type": "string"}}, Required: []string{"domain"}},
	{Name: "curl_headers", Description: "Show HTTP response headers.", Command: "curl", Args: []string{"-sI"}, Properties: map[string]map[string]interface{}{"url": {"type": "string"}}, Required: []string{"url"}},

	// =========================================================================
	// SECURITY
	// =========================================================================
	{Name: "ssh_keygen", Description: "Generate SSH key pair.", Command: "ssh-keygen", Args: []string{"-t", "ed25519", "-f", "/tmp/yaver-key", "-N", "", "-C", "generated-by-yaver"}},
	{Name: "ssh_keys_list", Description: "List SSH keys in ~/.ssh.", Command: "ls", Args: []string{"-la"}},
	{Name: "openssl_rand", Description: "Generate random hex string.", Command: "openssl", Args: []string{"rand", "-hex", "32"}},
	{Name: "openssl_cert_info", Description: "Show SSL certificate details.", Command: "openssl", Args: []string{"x509", "-text", "-noout", "-in"}, Properties: map[string]map[string]interface{}{"file": {"type": "string", "description": "Certificate file path"}}, Required: []string{"file"}},
	{Name: "gpg_list_keys", Description: "List GPG keys.", Command: "gpg", Args: []string{"--list-keys"}},
	{Name: "fail2ban_status", Description: "Show fail2ban status.", Command: "sudo", Args: []string{"fail2ban-client", "status"}},

	// =========================================================================
	// GIT ADVANCED
	// =========================================================================
	{Name: "git_stash_list", Description: "List git stashes.", Command: "git", Args: []string{"stash", "list"}, WorkDir: true},
	{Name: "git_stash_save", Description: "Stash current changes.", Command: "git", Args: []string{"stash", "push", "-m"}, Properties: map[string]map[string]interface{}{"message": {"type": "string"}}, Required: []string{"message"}, WorkDir: true},
	{Name: "git_stash_pop", Description: "Pop latest stash.", Command: "git", Args: []string{"stash", "pop"}, WorkDir: true},
	{Name: "git_blame", Description: "Show line-by-line blame.", Command: "git", Args: []string{"blame"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}, WorkDir: true},
	{Name: "git_shortlog", Description: "Show commit count by author.", Command: "git", Args: []string{"shortlog", "-sne"}, WorkDir: true},
	{Name: "git_reflog", Description: "Show git reflog.", Command: "git", Args: []string{"reflog", "--oneline", "-20"}, WorkDir: true},
	{Name: "git_tag_list", Description: "List git tags.", Command: "git", Args: []string{"tag", "--sort=-creatordate"}, WorkDir: true},
	{Name: "git_branch_list", Description: "List all branches.", Command: "git", Args: []string{"branch", "-a", "-v"}, WorkDir: true},
	{Name: "git_remote_list", Description: "List git remotes.", Command: "git", Args: []string{"remote", "-v"}, WorkDir: true},
	{Name: "git_log_graph", Description: "Show git log as graph.", Command: "git", Args: []string{"log", "--oneline", "--graph", "--all", "-20"}, WorkDir: true},
	{Name: "git_log_stat", Description: "Show git log with file stats.", Command: "git", Args: []string{"log", "--stat", "-10"}, WorkDir: true},
	{Name: "git_diff_staged", Description: "Show staged changes.", Command: "git", Args: []string{"diff", "--cached"}, WorkDir: true},
	{Name: "git_diff_summary", Description: "Show diff summary.", Command: "git", Args: []string{"diff", "--stat"}, WorkDir: true},
	{Name: "git_worktree_list", Description: "List git worktrees.", Command: "git", Args: []string{"worktree", "list"}, WorkDir: true},
	{Name: "git_submodule_list", Description: "List git submodules.", Command: "git", Args: []string{"submodule", "status"}, WorkDir: true},
	{Name: "git_lfs_list", Description: "List Git LFS tracked files.", Command: "git", Args: []string{"lfs", "ls-files"}, WorkDir: true},
	{Name: "git_clean_dry", Description: "Show what git clean would remove.", Command: "git", Args: []string{"clean", "-n", "-d"}, WorkDir: true},
	{Name: "git_contributors", Description: "Show all contributors.", Command: "git", Args: []string{"log", "--format=%aN <%aE>", "--all"}, WorkDir: true},

	// =========================================================================
	// CONTAINER & ORCHESTRATION
	// =========================================================================
	// Helm
	{Name: "helm_list", Description: "List Helm releases.", Command: "helm", Args: []string{"list", "--all-namespaces"}},
	{Name: "helm_status", Description: "Show Helm release status.", Command: "helm", Args: []string{"status"}, Properties: map[string]map[string]interface{}{"release": {"type": "string"}}, Required: []string{"release"}},
	{Name: "helm_repos", Description: "List Helm repositories.", Command: "helm", Args: []string{"repo", "list"}},
	{Name: "helm_search", Description: "Search Helm charts.", Command: "helm", Args: []string{"search", "hub"}, Properties: map[string]map[string]interface{}{"query": {"type": "string"}}, Required: []string{"query"}},
	{Name: "helm_values", Description: "Show Helm release values.", Command: "helm", Args: []string{"get", "values"}, Properties: map[string]map[string]interface{}{"release": {"type": "string"}}, Required: []string{"release"}},
	{Name: "helm_history", Description: "Show Helm release history.", Command: "helm", Args: []string{"history"}, Properties: map[string]map[string]interface{}{"release": {"type": "string"}}, Required: []string{"release"}},

	// Podman
	{Name: "podman_ps", Description: "List Podman containers.", Command: "podman", Args: []string{"ps", "-a"}},
	{Name: "podman_images", Description: "List Podman images.", Command: "podman", Args: []string{"images"}},

	// Skopeo
	{Name: "skopeo_inspect", Description: "Inspect a container image.", Command: "skopeo", Args: []string{"inspect"}, Properties: map[string]map[string]interface{}{"image": {"type": "string", "description": "e.g. docker://nginx:latest"}}, Required: []string{"image"}},

	// =========================================================================
	// BUILD SYSTEMS
	// =========================================================================
	{Name: "make_targets", Description: "List Makefile targets.", Command: "make", Args: []string{"-qp"}, WorkDir: true},
	{Name: "cmake_configure", Description: "Run cmake configure.", Command: "cmake", Args: []string{"-B", "build"}, WorkDir: true},
	{Name: "cmake_build", Description: "Run cmake build.", Command: "cmake", Args: []string{"--build", "build"}, WorkDir: true},
	{Name: "bazel_build", Description: "Run bazel build.", Command: "bazel", Args: []string{"build", "//..."}, WorkDir: true},
	{Name: "bazel_test", Description: "Run bazel test.", Command: "bazel", Args: []string{"test", "//..."}, WorkDir: true},
	{Name: "meson_setup", Description: "Setup meson build.", Command: "meson", Args: []string{"setup", "build"}, WorkDir: true},
	{Name: "ninja_build", Description: "Run ninja build.", Command: "ninja", Args: []string{"-C", "build"}, WorkDir: true},

	// =========================================================================
	// VIRTUALIZATION
	// =========================================================================
	{Name: "vagrant_status", Description: "Show Vagrant VM status.", Command: "vagrant", Args: []string{"status"}, WorkDir: true},
	{Name: "vagrant_up", Description: "Start Vagrant VM.", Command: "vagrant", Args: []string{"up"}, WorkDir: true},
	{Name: "vagrant_halt", Description: "Stop Vagrant VM.", Command: "vagrant", Args: []string{"halt"}, WorkDir: true},
	{Name: "vagrant_ssh_config", Description: "Show Vagrant SSH config.", Command: "vagrant", Args: []string{"ssh-config"}, WorkDir: true},
	{Name: "multipass_list", Description: "List Multipass VMs.", Command: "multipass", Args: []string{"list"}},
	{Name: "multipass_info", Description: "Show Multipass VM info.", Command: "multipass", Args: []string{"info"}, Properties: map[string]map[string]interface{}{"name": {"type": "string"}}, Required: []string{"name"}},

	// =========================================================================
	// BACKUP & SYNC
	// =========================================================================
	{Name: "rsync_dry", Description: "Dry-run rsync to see what would change.", Command: "rsync", Args: []string{"-avzn"}, Properties: map[string]map[string]interface{}{"source": {"type": "string"}, "dest": {"type": "string"}}, Required: []string{"source", "dest"}},
	{Name: "rclone_ls", Description: "List rclone remote files.", Command: "rclone", Args: []string{"ls"}, Properties: map[string]map[string]interface{}{"remote": {"type": "string", "description": "e.g. myremote:path"}}, Required: []string{"remote"}},
	{Name: "rclone_remotes", Description: "List rclone remotes.", Command: "rclone", Args: []string{"listremotes"}},
	{Name: "restic_snapshots", Description: "List restic backup snapshots.", Command: "restic", Args: []string{"snapshots"}},

	// =========================================================================
	// MEDIA
	// =========================================================================
	{Name: "ffmpeg_info", Description: "Show media file info.", Command: "ffprobe", Args: []string{"-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "imagemagick_info", Description: "Show image file info.", Command: "identify", Args: []string{"-verbose"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "imagemagick_resize", Description: "Resize an image.", Command: "convert", Properties: map[string]map[string]interface{}{"input": {"type": "string"}, "size": {"type": "string", "description": "e.g. 800x600"}, "output": {"type": "string"}}, Required: []string{"input", "size", "output"}},
	{Name: "exiftool_read", Description: "Read image EXIF data.", Command: "exiftool", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},

	// =========================================================================
	// DOCUMENTATION
	// =========================================================================
	{Name: "pandoc_convert", Description: "Convert documents with pandoc.", Command: "pandoc", Properties: map[string]map[string]interface{}{"input": {"type": "string"}, "output": {"type": "string"}, "format": {"type": "string", "description": "Output format (pdf, html, docx, epub)"}}, Required: []string{"input", "output"}},
	{Name: "mkdocs_build", Description: "Build MkDocs documentation.", Command: "mkdocs", Args: []string{"build"}, WorkDir: true},
	{Name: "mkdocs_serve", Description: "Serve MkDocs locally.", Command: "mkdocs", Args: []string{"serve", "-a", "0.0.0.0:8000"}, WorkDir: true},
	{Name: "sphinx_build", Description: "Build Sphinx documentation.", Command: "sphinx-build", Args: []string{"-b", "html", "docs", "docs/_build"}, WorkDir: true},
	{Name: "typedoc_generate", Description: "Generate TypeDoc documentation.", Command: "npx", Args: []string{"typedoc"}, WorkDir: true},
	{Name: "godoc_serve", Description: "Start Go documentation server.", Command: "godoc", Args: []string{"-http=:6060"}},
	{Name: "javadoc_generate", Description: "Generate Javadoc.", Command: "javadoc", Args: []string{"-d", "docs"}, WorkDir: true},

	// =========================================================================
	// PROFILING & DEBUGGING
	// =========================================================================
	{Name: "go_pprof_cpu", Description: "Go CPU profiling.", Command: "go", Args: []string{"test", "-cpuprofile=cpu.prof", "-bench=."}, WorkDir: true},
	{Name: "go_pprof_mem", Description: "Go memory profiling.", Command: "go", Args: []string{"test", "-memprofile=mem.prof", "-bench=."}, WorkDir: true},
	{Name: "perf_stat", Description: "Performance counters for a command.", Command: "perf", Args: []string{"stat"}, Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}},
	{Name: "strace_cmd", Description: "Trace system calls.", Command: "strace", Args: []string{"-c"}, Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}},
	{Name: "ltrace_cmd", Description: "Trace library calls.", Command: "ltrace", Args: []string{"-c"}, Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}},
	{Name: "valgrind_check", Description: "Check for memory leaks.", Command: "valgrind", Args: []string{"--leak-check=full"}, Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}},

	// =========================================================================
	// MESSAGE QUEUES & STREAMING
	// =========================================================================
	{Name: "kafka_topics", Description: "List Kafka topics.", Command: "kafka-topics", Args: []string{"--list", "--bootstrap-server", "localhost:9092"}},
	{Name: "rabbitmq_status", Description: "Show RabbitMQ status.", Command: "rabbitmqctl", Args: []string{"status"}},
	{Name: "rabbitmq_queues", Description: "List RabbitMQ queues.", Command: "rabbitmqctl", Args: []string{"list_queues"}},
	{Name: "nats_server_info", Description: "Show NATS server info.", Command: "nats", Args: []string{"server", "info"}},
	{Name: "redis_info", Description: "Show Redis server info.", Command: "redis-cli", Args: []string{"info"}},
	{Name: "redis_keys", Description: "List Redis keys.", Command: "redis-cli", Args: []string{"keys", "*"}},
	{Name: "memcached_stats", Description: "Show Memcached stats.", Command: "sh", Args: []string{"-c", "echo stats | nc localhost 11211"}},

	// =========================================================================
	// WEB SERVERS
	// =========================================================================
	{Name: "nginx_test", Description: "Test nginx configuration.", Command: "sudo", Args: []string{"nginx", "-t"}},
	{Name: "nginx_reload", Description: "Reload nginx configuration.", Command: "sudo", Args: []string{"nginx", "-s", "reload"}},
	{Name: "apache_test", Description: "Test Apache configuration.", Command: "apachectl", Args: []string{"configtest"}},
	{Name: "caddy_validate", Description: "Validate Caddy config.", Command: "caddy", Args: []string{"validate"}},
	{Name: "caddy_reload", Description: "Reload Caddy config.", Command: "caddy", Args: []string{"reload"}},

	// =========================================================================
	// SEARCH ENGINES
	// =========================================================================
	{Name: "es_health", Description: "Elasticsearch cluster health.", Command: "curl", Args: []string{"-s", "localhost:9200/_cluster/health?pretty"}},
	{Name: "es_indices", Description: "List Elasticsearch indices.", Command: "curl", Args: []string{"-s", "localhost:9200/_cat/indices?v"}},
	{Name: "meilisearch_health", Description: "Meilisearch health check.", Command: "curl", Args: []string{"-s", "localhost:7700/health"}},
	{Name: "meilisearch_indexes", Description: "List Meilisearch indexes.", Command: "curl", Args: []string{"-s", "localhost:7700/indexes"}},

	// =========================================================================
	// REVERSE PROXY & LOAD BALANCER
	// =========================================================================
	{Name: "traefik_health", Description: "Traefik health check.", Command: "curl", Args: []string{"-s", "localhost:8080/api/overview"}},
	{Name: "haproxy_stats", Description: "HAProxy stats.", Command: "curl", Args: []string{"-s", "localhost:9000/stats"}},

	// =========================================================================
	// IaC & CONFIG MANAGEMENT
	// =========================================================================
	{Name: "ansible_ping", Description: "Ansible ping all hosts.", Command: "ansible", Args: []string{"all", "-m", "ping"}},
	{Name: "ansible_hosts", Description: "List Ansible inventory hosts.", Command: "ansible", Args: []string{"all", "--list-hosts"}},
	{Name: "ansible_playbook", Description: "Run Ansible playbook.", Command: "ansible-playbook", Properties: map[string]map[string]interface{}{"playbook": {"type": "string", "description": "Playbook YAML file"}}, Required: []string{"playbook"}},
	{Name: "pulumi_stack", Description: "Show Pulumi stack.", Command: "pulumi", Args: []string{"stack"}},
	{Name: "pulumi_up", Description: "Run Pulumi up (preview).", Command: "pulumi", Args: []string{"preview"}, WorkDir: true},

	// =========================================================================
	// SECRETS MANAGEMENT
	// =========================================================================
	{Name: "vault_status", Description: "HashiCorp Vault status.", Command: "vault", Args: []string{"status"}},
	{Name: "vault_list", Description: "List Vault secrets.", Command: "vault", Args: []string{"kv", "list"}, Properties: map[string]map[string]interface{}{"path": {"type": "string", "description": "Secret path (e.g. secret/)"}}, Required: []string{"path"}},
	{Name: "sops_decrypt", Description: "Decrypt a SOPS-encrypted file.", Command: "sops", Args: []string{"-d"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},

	// =========================================================================
	// AWS (granular services)
	// =========================================================================
	{Name: "aws_s3_ls", Description: "List S3 buckets.", Command: "aws", Args: []string{"s3", "ls"}},
	{Name: "aws_s3_ls_bucket", Description: "List objects in S3 bucket.", Command: "aws", Args: []string{"s3", "ls"}, Properties: map[string]map[string]interface{}{"bucket": {"type": "string", "description": "s3://bucket-name/"}}, Required: []string{"bucket"}},
	{Name: "aws_ec2_instances", Description: "List EC2 instances.", Command: "aws", Args: []string{"ec2", "describe-instances", "--query", "Reservations[].Instances[].[InstanceId,State.Name,InstanceType,PublicIpAddress,Tags[?Key=='Name'].Value|[0]]", "--output", "table"}},
	{Name: "aws_ec2_sg", Description: "List EC2 security groups.", Command: "aws", Args: []string{"ec2", "describe-security-groups", "--output", "table"}},
	{Name: "aws_ecs_clusters", Description: "List ECS clusters.", Command: "aws", Args: []string{"ecs", "list-clusters"}},
	{Name: "aws_ecs_services", Description: "List ECS services.", Command: "aws", Args: []string{"ecs", "list-services", "--cluster"}, Properties: map[string]map[string]interface{}{"cluster": {"type": "string"}}, Required: []string{"cluster"}},
	{Name: "aws_rds_instances", Description: "List RDS database instances.", Command: "aws", Args: []string{"rds", "describe-db-instances", "--query", "DBInstances[].[DBInstanceIdentifier,Engine,DBInstanceStatus,Endpoint.Address]", "--output", "table"}},
	{Name: "aws_cloudfront_list", Description: "List CloudFront distributions.", Command: "aws", Args: []string{"cloudfront", "list-distributions", "--query", "DistributionList.Items[].[Id,DomainName,Status]", "--output", "table"}},
	{Name: "aws_route53_zones", Description: "List Route53 hosted zones.", Command: "aws", Args: []string{"route53", "list-hosted-zones", "--output", "table"}},
	{Name: "aws_iam_users", Description: "List IAM users.", Command: "aws", Args: []string{"iam", "list-users", "--output", "table"}},
	{Name: "aws_sqs_queues", Description: "List SQS queues.", Command: "aws", Args: []string{"sqs", "list-queues"}},
	{Name: "aws_sns_topics", Description: "List SNS topics.", Command: "aws", Args: []string{"sns", "list-topics"}},
	{Name: "aws_dynamodb_tables", Description: "List DynamoDB tables.", Command: "aws", Args: []string{"dynamodb", "list-tables"}},
	{Name: "aws_ecr_repos", Description: "List ECR repositories.", Command: "aws", Args: []string{"ecr", "describe-repositories", "--output", "table"}},
	{Name: "aws_cloudwatch_alarms", Description: "List CloudWatch alarms.", Command: "aws", Args: []string{"cloudwatch", "describe-alarms", "--state-value", "ALARM", "--output", "table"}},
	{Name: "aws_ssm_parameters", Description: "List SSM parameters.", Command: "aws", Args: []string{"ssm", "describe-parameters", "--output", "table"}},
	{Name: "aws_sts_identity", Description: "Show current AWS identity.", Command: "aws", Args: []string{"sts", "get-caller-identity"}},
	{Name: "aws_cost", Description: "Show AWS cost for current month.", Command: "aws", Args: []string{"ce", "get-cost-and-usage", "--time-period", "Start=2024-01-01,End=2024-12-31", "--granularity", "MONTHLY", "--metrics", "UnblendedCost"}},

	// =========================================================================
	// GCP (granular services)
	// =========================================================================
	{Name: "gcloud_projects", Description: "List GCP projects.", Command: "gcloud", Args: []string{"projects", "list"}},
	{Name: "gcloud_compute_instances", Description: "List GCP compute instances.", Command: "gcloud", Args: []string{"compute", "instances", "list"}},
	{Name: "gcloud_functions", Description: "List GCP Cloud Functions.", Command: "gcloud", Args: []string{"functions", "list"}},
	{Name: "gcloud_run_services", Description: "List Cloud Run services.", Command: "gcloud", Args: []string{"run", "services", "list"}},
	{Name: "gcloud_sql_instances", Description: "List Cloud SQL instances.", Command: "gcloud", Args: []string{"sql", "instances", "list"}},
	{Name: "gcloud_storage_buckets", Description: "List GCS buckets.", Command: "gsutil", Args: []string{"ls"}},
	{Name: "gcloud_pubsub_topics", Description: "List Pub/Sub topics.", Command: "gcloud", Args: []string{"pubsub", "topics", "list"}},
	{Name: "gcloud_config", Description: "Show current gcloud config.", Command: "gcloud", Args: []string{"config", "list"}},

	// =========================================================================
	// AZURE (granular services)
	// =========================================================================
	{Name: "az_account", Description: "Show Azure account info.", Command: "az", Args: []string{"account", "show"}},
	{Name: "az_vm_list", Description: "List Azure VMs.", Command: "az", Args: []string{"vm", "list", "--output", "table"}},
	{Name: "az_webapp_list", Description: "List Azure Web Apps.", Command: "az", Args: []string{"webapp", "list", "--output", "table"}},
	{Name: "az_storage_accounts", Description: "List Azure Storage accounts.", Command: "az", Args: []string{"storage", "account", "list", "--output", "table"}},
	{Name: "az_aks_list", Description: "List AKS clusters.", Command: "az", Args: []string{"aks", "list", "--output", "table"}},
	{Name: "az_cosmosdb_list", Description: "List Cosmos DB accounts.", Command: "az", Args: []string{"cosmosdb", "list", "--output", "table"}},
	{Name: "az_functions_list", Description: "List Azure Functions.", Command: "az", Args: []string{"functionapp", "list", "--output", "table"}},

	// =========================================================================
	// MONITORING & OBSERVABILITY
	// =========================================================================
	{Name: "prometheus_targets", Description: "Show Prometheus targets.", Command: "curl", Args: []string{"-s", "localhost:9090/api/v1/targets"}},
	{Name: "prometheus_alerts", Description: "Show Prometheus alerts.", Command: "curl", Args: []string{"-s", "localhost:9090/api/v1/alerts"}},
	{Name: "grafana_datasources", Description: "List Grafana datasources.", Command: "curl", Args: []string{"-s", "localhost:3000/api/datasources"}},

	// =========================================================================
	// TEXT PROCESSING (useful for pipes)
	// =========================================================================
	{Name: "wc_file", Description: "Count lines, words, chars in a file.", Command: "wc", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "sort_file", Description: "Sort lines in a file.", Command: "sort", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "uniq_file", Description: "Show unique lines.", Command: "sort", Args: []string{"-u"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "head_file", Description: "Show first N lines of a file.", Command: "head", Args: []string{"-20"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "tail_file", Description: "Show last N lines of a file.", Command: "tail", Args: []string{"-20"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "md5sum_file", Description: "Calculate MD5 checksum of a file.", Command: "md5sum", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "sha256sum_file", Description: "Calculate SHA256 checksum of a file.", Command: "sha256sum", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "file_type", Description: "Detect file type.", Command: "file", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "stat_file", Description: "Show file metadata.", Command: "stat", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "hexdump", Description: "Hex dump of a file.", Command: "xxd", Args: []string{"-l", "256"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},

	// =========================================================================
	// LANGUAGE-SPECIFIC TOOLS
	// =========================================================================
	// Python
	{Name: "python_version", Description: "Show Python version.", Command: "python3", Args: []string{"--version"}},
	{Name: "python_venv_create", Description: "Create Python virtual environment.", Command: "python3", Args: []string{"-m", "venv", ".venv"}, WorkDir: true},
	{Name: "python_venv_activate", Description: "Show venv activation command.", Command: "echo", Args: []string{"source .venv/bin/activate"}},
	{Name: "black_format", Description: "Format Python with Black.", Command: "black", Args: []string{"."}, WorkDir: true},
	{Name: "ruff_check", Description: "Lint Python with Ruff.", Command: "ruff", Args: []string{"check", "."}, WorkDir: true},
	{Name: "ruff_format", Description: "Format Python with Ruff.", Command: "ruff", Args: []string{"format", "."}, WorkDir: true},
	{Name: "mypy_check", Description: "Type-check Python with mypy.", Command: "mypy", Args: []string{"."}, WorkDir: true},
	{Name: "pyright_check", Description: "Type-check Python with pyright.", Command: "pyright", WorkDir: true},
	{Name: "pytest_run", Description: "Run Python tests with pytest.", Command: "pytest", Args: []string{"-v"}, WorkDir: true},
	{Name: "pytest_coverage", Description: "Run pytest with coverage.", Command: "pytest", Args: []string{"--cov", "-v"}, WorkDir: true},
	{Name: "uvicorn_start", Description: "Start uvicorn server.", Command: "uvicorn", Args: []string{"main:app", "--reload"}, WorkDir: true},

	// Node.js
	{Name: "node_version", Description: "Show Node.js version.", Command: "node", Args: []string{"--version"}},
	{Name: "npm_ls", Description: "List npm dependencies.", Command: "npm", Args: []string{"ls", "--depth=0"}, WorkDir: true},
	{Name: "npm_run", Description: "List npm scripts.", Command: "npm", Args: []string{"run"}, WorkDir: true},
	{Name: "npm_audit_fix", Description: "Fix npm audit issues.", Command: "npm", Args: []string{"audit", "fix"}, WorkDir: true},
	{Name: "npx_tsc", Description: "Run TypeScript compiler.", Command: "npx", Args: []string{"tsc", "--noEmit"}, WorkDir: true},
	{Name: "npx_prettier", Description: "Format with Prettier.", Command: "npx", Args: []string{"prettier", "--write", "."}, WorkDir: true},
	{Name: "npx_eslint", Description: "Lint with ESLint.", Command: "npx", Args: []string{"eslint", "."}, WorkDir: true},
	{Name: "npx_jest", Description: "Run tests with Jest.", Command: "npx", Args: []string{"jest", "--verbose"}, WorkDir: true},
	{Name: "npx_vitest", Description: "Run tests with Vitest.", Command: "npx", Args: []string{"vitest", "run"}, WorkDir: true},
	{Name: "npx_next_build", Description: "Build Next.js app.", Command: "npx", Args: []string{"next", "build"}, WorkDir: true},
	{Name: "npx_next_lint", Description: "Lint Next.js app.", Command: "npx", Args: []string{"next", "lint"}, WorkDir: true},
	{Name: "npm_outdated_json", Description: "Show outdated npm packages (JSON).", Command: "npm", Args: []string{"outdated", "--json"}, WorkDir: true},
	{Name: "pnpm_ls", Description: "List pnpm dependencies.", Command: "pnpm", Args: []string{"ls"}, WorkDir: true},
	{Name: "yarn_info", Description: "Show Yarn package info.", Command: "yarn", Args: []string{"info"}, WorkDir: true},
	{Name: "bun_run", Description: "List Bun scripts.", Command: "bun", Args: []string{"run"}, WorkDir: true},
	{Name: "deno_info", Description: "Show Deno info.", Command: "deno", Args: []string{"info"}},
	{Name: "deno_lint", Description: "Lint with Deno.", Command: "deno", Args: []string{"lint"}, WorkDir: true},
	{Name: "deno_test", Description: "Test with Deno.", Command: "deno", Args: []string{"test"}, WorkDir: true},

	// Go
	{Name: "go_version", Description: "Show Go version.", Command: "go", Args: []string{"version"}},
	{Name: "go_mod_tidy", Description: "Tidy Go modules.", Command: "go", Args: []string{"mod", "tidy"}, WorkDir: true},
	{Name: "go_mod_graph", Description: "Show Go module graph.", Command: "go", Args: []string{"mod", "graph"}, WorkDir: true},
	{Name: "go_vet", Description: "Run Go vet.", Command: "go", Args: []string{"vet", "./..."}, WorkDir: true},
	{Name: "go_test_all", Description: "Run all Go tests.", Command: "go", Args: []string{"test", "-v", "./..."}, WorkDir: true},
	{Name: "go_test_race", Description: "Run Go tests with race detector.", Command: "go", Args: []string{"test", "-race", "./..."}, WorkDir: true},
	{Name: "go_test_cover", Description: "Run Go tests with coverage.", Command: "go", Args: []string{"test", "-cover", "./..."}, WorkDir: true},
	{Name: "go_build_check", Description: "Check Go build without output.", Command: "go", Args: []string{"build", "./..."}, WorkDir: true},
	{Name: "golangci_lint", Description: "Run golangci-lint.", Command: "golangci-lint", Args: []string{"run"}, WorkDir: true},
	{Name: "gofmt_check", Description: "Check Go formatting.", Command: "gofmt", Args: []string{"-l", "."}, WorkDir: true},
	{Name: "staticcheck", Description: "Run Go staticcheck.", Command: "staticcheck", Args: []string{"./..."}, WorkDir: true},

	// Rust
	{Name: "rustc_version", Description: "Show Rust version.", Command: "rustc", Args: []string{"--version"}},
	{Name: "cargo_build", Description: "Build Rust project.", Command: "cargo", Args: []string{"build"}, WorkDir: true},
	{Name: "cargo_test", Description: "Run Rust tests.", Command: "cargo", Args: []string{"test"}, WorkDir: true},
	{Name: "cargo_clippy", Description: "Lint Rust with clippy.", Command: "cargo", Args: []string{"clippy"}, WorkDir: true},
	{Name: "cargo_fmt", Description: "Format Rust code.", Command: "cargo", Args: []string{"fmt"}, WorkDir: true},
	{Name: "cargo_doc", Description: "Build Rust docs.", Command: "cargo", Args: []string{"doc", "--no-deps"}, WorkDir: true},
	{Name: "cargo_bench_run", Description: "Run Rust benchmarks.", Command: "cargo", Args: []string{"bench"}, WorkDir: true},
	{Name: "cargo_check", Description: "Check Rust without building.", Command: "cargo", Args: []string{"check"}, WorkDir: true},
	{Name: "cargo_tree", Description: "Show dependency tree.", Command: "cargo", Args: []string{"tree"}, WorkDir: true},
	{Name: "cargo_update", Description: "Update Rust dependencies.", Command: "cargo", Args: []string{"update"}, WorkDir: true},

	// Java/Kotlin
	{Name: "java_version", Description: "Show Java version.", Command: "java", Args: []string{"-version"}},
	{Name: "mvn_compile", Description: "Maven compile.", Command: "mvn", Args: []string{"compile"}, WorkDir: true},
	{Name: "mvn_test", Description: "Maven test.", Command: "mvn", Args: []string{"test"}, WorkDir: true},
	{Name: "mvn_package", Description: "Maven package.", Command: "mvn", Args: []string{"package"}, WorkDir: true},
	{Name: "mvn_dependency_tree", Description: "Maven dependency tree.", Command: "mvn", Args: []string{"dependency:tree"}, WorkDir: true},
	{Name: "gradle_tasks", Description: "List Gradle tasks.", Command: "gradle", Args: []string{"tasks"}, WorkDir: true},
	{Name: "gradle_deps", Description: "Show Gradle dependencies.", Command: "gradle", Args: []string{"dependencies"}, WorkDir: true},

	// Ruby
	{Name: "ruby_version", Description: "Show Ruby version.", Command: "ruby", Args: []string{"--version"}},
	{Name: "bundle_install", Description: "Install Ruby gems.", Command: "bundle", Args: []string{"install"}, WorkDir: true},
	{Name: "bundle_outdated", Description: "Check outdated gems.", Command: "bundle", Args: []string{"outdated"}, WorkDir: true},
	{Name: "rails_routes", Description: "Show Rails routes.", Command: "rails", Args: []string{"routes"}, WorkDir: true},
	{Name: "rspec_run", Description: "Run RSpec tests.", Command: "rspec", WorkDir: true},
	{Name: "rubocop_check", Description: "Run RuboCop linter.", Command: "rubocop", WorkDir: true},

	// PHP
	{Name: "php_version", Description: "Show PHP version.", Command: "php", Args: []string{"-v"}},
	{Name: "composer_install", Description: "Install Composer packages.", Command: "composer", Args: []string{"install"}, WorkDir: true},
	{Name: "composer_outdated", Description: "Check outdated Composer packages.", Command: "composer", Args: []string{"outdated"}, WorkDir: true},
	{Name: "phpunit_run", Description: "Run PHPUnit tests.", Command: "phpunit", WorkDir: true},
	{Name: "phpstan_check", Description: "Run PHPStan static analysis.", Command: "phpstan", Args: []string{"analyse"}, WorkDir: true},
	{Name: "artisan_routes", Description: "Show Laravel routes.", Command: "php", Args: []string{"artisan", "route:list"}, WorkDir: true},

	// Swift
	{Name: "swift_version", Description: "Show Swift version.", Command: "swift", Args: []string{"--version"}},
	{Name: "swift_build", Description: "Build Swift package.", Command: "swift", Args: []string{"build"}, WorkDir: true},
	{Name: "swift_test", Description: "Run Swift tests.", Command: "swift", Args: []string{"test"}, WorkDir: true},

	// Elixir
	{Name: "elixir_version", Description: "Show Elixir version.", Command: "elixir", Args: []string{"--version"}},
	{Name: "mix_deps_get", Description: "Get Elixir dependencies.", Command: "mix", Args: []string{"deps.get"}, WorkDir: true},
	{Name: "mix_test", Description: "Run Elixir tests.", Command: "mix", Args: []string{"test"}, WorkDir: true},
	{Name: "mix_format", Description: "Format Elixir code.", Command: "mix", Args: []string{"format"}, WorkDir: true},

	// Zig
	{Name: "zig_version", Description: "Show Zig version.", Command: "zig", Args: []string{"version"}},
	{Name: "zig_build", Description: "Build Zig project.", Command: "zig", Args: []string{"build"}, WorkDir: true},
	{Name: "zig_test", Description: "Run Zig tests.", Command: "zig", Args: []string{"test"}, WorkDir: true},

	// .NET
	{Name: "dotnet_version", Description: "Show .NET version.", Command: "dotnet", Args: []string{"--version"}},
	{Name: "dotnet_build", Description: "Build .NET project.", Command: "dotnet", Args: []string{"build"}, WorkDir: true},
	{Name: "dotnet_test", Description: "Run .NET tests.", Command: "dotnet", Args: []string{"test"}, WorkDir: true},
	{Name: "dotnet_run", Description: "Run .NET project.", Command: "dotnet", Args: []string{"run"}, WorkDir: true},

	// Haskell
	{Name: "ghc_version", Description: "Show GHC version.", Command: "ghc", Args: []string{"--version"}},
	{Name: "stack_build", Description: "Build Haskell with Stack.", Command: "stack", Args: []string{"build"}, WorkDir: true},
	{Name: "stack_test", Description: "Test Haskell with Stack.", Command: "stack", Args: []string{"test"}, WorkDir: true},
	{Name: "cabal_build", Description: "Build Haskell with Cabal.", Command: "cabal", Args: []string{"build"}, WorkDir: true},

	// Scala
	{Name: "sbt_compile", Description: "Compile Scala with sbt.", Command: "sbt", Args: []string{"compile"}, WorkDir: true},
	{Name: "sbt_test", Description: "Test Scala with sbt.", Command: "sbt", Args: []string{"test"}, WorkDir: true},

	// C/C++
	{Name: "gcc_version", Description: "Show GCC version.", Command: "gcc", Args: []string{"--version"}},
	{Name: "clang_version", Description: "Show Clang version.", Command: "clang", Args: []string{"--version"}},
	{Name: "clang_format", Description: "Format C/C++ with clang-format.", Command: "clang-format", Args: []string{"-i"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "clang_tidy", Description: "Run clang-tidy static analysis.", Command: "clang-tidy", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "cppcheck", Description: "Run cppcheck analysis.", Command: "cppcheck", Args: []string{"--enable=all"}, Properties: map[string]map[string]interface{}{"directory": {"type": "string"}}, Required: []string{"directory"}},

	// Lua
	{Name: "lua_version", Description: "Show Lua version.", Command: "lua", Args: []string{"-v"}},
	{Name: "luarocks_list", Description: "List Lua packages.", Command: "luarocks", Args: []string{"list"}},

	// R
	{Name: "r_version", Description: "Show R version.", Command: "R", Args: []string{"--version"}},

	// Julia
	{Name: "julia_version", Description: "Show Julia version.", Command: "julia", Args: []string{"--version"}},

	// Perl
	{Name: "perl_version", Description: "Show Perl version.", Command: "perl", Args: []string{"-v"}},

	// =========================================================================
	// NMAP / SECURITY SCANNING
	// =========================================================================
	{Name: "nmap_quick", Description: "Quick nmap scan.", Command: "nmap", Args: []string{"-F"}, Properties: map[string]map[string]interface{}{"target": {"type": "string"}}, Required: []string{"target"}},
	{Name: "nmap_services", Description: "Nmap service version scan.", Command: "nmap", Args: []string{"-sV"}, Properties: map[string]map[string]interface{}{"target": {"type": "string"}}, Required: []string{"target"}},

	// =========================================================================
	// MISC DEVELOPER TOOLS
	// =========================================================================
	{Name: "which_cmd", Description: "Find command location.", Command: "which", Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}},
	{Name: "alias_list", Description: "List shell aliases.", Command: "alias"},
	{Name: "env_path", Description: "Show PATH variable.", Command: "sh", Args: []string{"-c", "echo $PATH | tr ':' '\\n'"}},
	{Name: "date_now", Description: "Show current date/time.", Command: "date"},
	{Name: "cal_month", Description: "Show calendar.", Command: "cal"},
	{Name: "history_recent", Description: "Show recent command history.", Command: "sh", Args: []string{"-c", "history 50 2>/dev/null || cat ~/.bash_history 2>/dev/null | tail -50 || cat ~/.zsh_history 2>/dev/null | tail -50"}},
	{Name: "tree_dir", Description: "Show directory tree.", Command: "tree", Args: []string{"-L", "2"}, WorkDir: true},
	{Name: "find_large_files", Description: "Find large files (>100MB).", Command: "find", Args: []string{".", "-type", "f", "-size", "+100M"}, WorkDir: true},
	{Name: "find_recent_files", Description: "Find recently modified files.", Command: "find", Args: []string{".", "-type", "f", "-mtime", "-1", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"}, WorkDir: true},
	{Name: "du_top", Description: "Show largest directories.", Command: "du", Args: []string{"-sh", "./*", "--max-depth=1"}, WorkDir: true},
	{Name: "nc_check", Description: "Check if a port is open.", Command: "nc", Args: []string{"-zv"}, Properties: map[string]map[string]interface{}{"host": {"type": "string"}, "port": {"type": "string"}}, Required: []string{"host", "port"}},
	{Name: "xdg_open", Description: "Open file with default app (Linux).", Command: "xdg-open", Properties: map[string]map[string]interface{}{"path": {"type": "string"}}, Required: []string{"path"}},
	{Name: "pbcopy_text", Description: "Copy text to macOS clipboard.", Command: "pbcopy"},
	{Name: "say_text", Description: "Speak text on macOS.", Command: "say", Properties: map[string]map[string]interface{}{"text": {"type": "string"}}, Required: []string{"text"}},
	{Name: "open_finder", Description: "Open directory in Finder (macOS).", Command: "open", Args: []string{"."}, WorkDir: true},
	{Name: "open_vscode", Description: "Open directory in VS Code.", Command: "code", Args: []string{"."}, WorkDir: true},
	{Name: "open_idea", Description: "Open directory in IntelliJ IDEA.", Command: "idea", Args: []string{"."}, WorkDir: true},
	{Name: "open_cursor", Description: "Open directory in Cursor.", Command: "cursor", Args: []string{"."}, WorkDir: true},
	{Name: "open_zed", Description: "Open directory in Zed.", Command: "zed", Args: []string{"."}, WorkDir: true},
	{Name: "open_sublime", Description: "Open directory in Sublime Text.", Command: "subl", Args: []string{"."}, WorkDir: true},

	// Tailscale
	{Name: "tailscale_status", Description: "Show Tailscale status.", Command: "tailscale", Args: []string{"status"}},
	{Name: "tailscale_ip", Description: "Show Tailscale IP.", Command: "tailscale", Args: []string{"ip"}},
	{Name: "tailscale_peers", Description: "List Tailscale peers.", Command: "tailscale", Args: []string{"status", "--json"}},

	// WireGuard
	{Name: "wg_show", Description: "Show WireGuard status.", Command: "sudo", Args: []string{"wg", "show"}},

	// Certbot / Let's Encrypt
	{Name: "certbot_certs", Description: "List Let's Encrypt certificates.", Command: "sudo", Args: []string{"certbot", "certificates"}},
	{Name: "certbot_renew", Description: "Renew Let's Encrypt certificates.", Command: "sudo", Args: []string{"certbot", "renew", "--dry-run"}},

	// =========================================================================
	// MORE AWS SERVICES
	// =========================================================================
	{Name: "aws_eks_clusters", Description: "List EKS clusters.", Command: "aws", Args: []string{"eks", "list-clusters"}},
	{Name: "aws_eks_nodegroups", Description: "List EKS node groups.", Command: "aws", Args: []string{"eks", "list-nodegroups", "--cluster-name"}, Properties: map[string]map[string]interface{}{"cluster": {"type": "string"}}, Required: []string{"cluster"}},
	{Name: "aws_elasticache", Description: "List ElastiCache clusters.", Command: "aws", Args: []string{"elasticache", "describe-cache-clusters", "--output", "table"}},
	{Name: "aws_kinesis_streams", Description: "List Kinesis streams.", Command: "aws", Args: []string{"kinesis", "list-streams"}},
	{Name: "aws_glue_jobs", Description: "List Glue jobs.", Command: "aws", Args: []string{"glue", "get-jobs", "--output", "table"}},
	{Name: "aws_athena_queries", Description: "List Athena queries.", Command: "aws", Args: []string{"athena", "list-named-queries"}},
	{Name: "aws_secrets", Description: "List Secrets Manager secrets.", Command: "aws", Args: []string{"secretsmanager", "list-secrets", "--output", "table"}},
	{Name: "aws_cognito_pools", Description: "List Cognito user pools.", Command: "aws", Args: []string{"cognito-idp", "list-user-pools", "--max-results", "20"}},
	{Name: "aws_stepfunctions", Description: "List Step Functions.", Command: "aws", Args: []string{"stepfunctions", "list-state-machines"}},
	{Name: "aws_eventbridge_rules", Description: "List EventBridge rules.", Command: "aws", Args: []string{"events", "list-rules"}},
	{Name: "aws_apigateway_apis", Description: "List API Gateway APIs.", Command: "aws", Args: []string{"apigatewayv2", "get-apis"}},
	{Name: "aws_amplify_apps", Description: "List Amplify apps.", Command: "aws", Args: []string{"amplify", "list-apps"}},
	{Name: "aws_lightsail_instances", Description: "List Lightsail instances.", Command: "aws", Args: []string{"lightsail", "get-instances", "--output", "table"}},
	{Name: "aws_ses_identities", Description: "List SES verified identities.", Command: "aws", Args: []string{"ses", "list-identities"}},
	{Name: "aws_codecommit_repos", Description: "List CodeCommit repos.", Command: "aws", Args: []string{"codecommit", "list-repositories"}},
	{Name: "aws_codebuild_projects", Description: "List CodeBuild projects.", Command: "aws", Args: []string{"codebuild", "list-projects"}},
	{Name: "aws_codepipeline_list", Description: "List CodePipeline pipelines.", Command: "aws", Args: []string{"codepipeline", "list-pipelines"}},
	{Name: "aws_codeartifact_repos", Description: "List CodeArtifact repos.", Command: "aws", Args: []string{"codeartifact", "list-repositories"}},
	{Name: "aws_batch_jobs", Description: "List AWS Batch jobs.", Command: "aws", Args: []string{"batch", "list-jobs", "--job-queue", "default"}},
	{Name: "aws_efs_filesystems", Description: "List EFS file systems.", Command: "aws", Args: []string{"efs", "describe-file-systems", "--output", "table"}},
	{Name: "aws_waf_rules", Description: "List WAF rules.", Command: "aws", Args: []string{"wafv2", "list-web-acls", "--scope", "REGIONAL"}},
	{Name: "aws_inspector_findings", Description: "List Inspector findings.", Command: "aws", Args: []string{"inspector2", "list-findings", "--max-results", "10"}},

	// =========================================================================
	// MORE GCP SERVICES
	// =========================================================================
	{Name: "gcloud_gke_clusters", Description: "List GKE clusters.", Command: "gcloud", Args: []string{"container", "clusters", "list"}},
	{Name: "gcloud_app_services", Description: "List App Engine services.", Command: "gcloud", Args: []string{"app", "services", "list"}},
	{Name: "gcloud_app_versions", Description: "List App Engine versions.", Command: "gcloud", Args: []string{"app", "versions", "list"}},
	{Name: "gcloud_artifacts_repos", Description: "List Artifact Registry repos.", Command: "gcloud", Args: []string{"artifacts", "repositories", "list"}},
	{Name: "gcloud_spanner_instances", Description: "List Spanner instances.", Command: "gcloud", Args: []string{"spanner", "instances", "list"}},
	{Name: "gcloud_bigtable_instances", Description: "List Bigtable instances.", Command: "gcloud", Args: []string{"bigtable", "instances", "list"}},
	{Name: "gcloud_memorystore", Description: "List Memorystore (Redis) instances.", Command: "gcloud", Args: []string{"redis", "instances", "list"}},
	{Name: "gcloud_scheduler_jobs", Description: "List Cloud Scheduler jobs.", Command: "gcloud", Args: []string{"scheduler", "jobs", "list"}},
	{Name: "gcloud_tasks_queues", Description: "List Cloud Tasks queues.", Command: "gcloud", Args: []string{"tasks", "queues", "list"}},
	{Name: "gcloud_secrets_list", Description: "List Secret Manager secrets.", Command: "gcloud", Args: []string{"secrets", "list"}},
	{Name: "gcloud_dns_zones", Description: "List Cloud DNS zones.", Command: "gcloud", Args: []string{"dns", "managed-zones", "list"}},
	{Name: "gcloud_firestore_indexes", Description: "List Firestore indexes.", Command: "gcloud", Args: []string{"firestore", "indexes", "composite", "list"}},
	{Name: "gcloud_endpoints", Description: "List Cloud Endpoints services.", Command: "gcloud", Args: []string{"endpoints", "services", "list"}},
	{Name: "gcloud_builds", Description: "List Cloud Build builds.", Command: "gcloud", Args: []string{"builds", "list", "--limit=10"}},
	{Name: "gcloud_deploy_targets", Description: "List Cloud Deploy targets.", Command: "gcloud", Args: []string{"deploy", "targets", "list"}},

	// =========================================================================
	// MORE AZURE SERVICES
	// =========================================================================
	{Name: "az_acr_list", Description: "List Azure Container Registries.", Command: "az", Args: []string{"acr", "list", "--output", "table"}},
	{Name: "az_sql_servers", Description: "List Azure SQL servers.", Command: "az", Args: []string{"sql", "server", "list", "--output", "table"}},
	{Name: "az_redis_list", Description: "List Azure Cache for Redis.", Command: "az", Args: []string{"redis", "list", "--output", "table"}},
	{Name: "az_servicebus", Description: "List Service Bus namespaces.", Command: "az", Args: []string{"servicebus", "namespace", "list", "--output", "table"}},
	{Name: "az_keyvault_list", Description: "List Azure Key Vaults.", Command: "az", Args: []string{"keyvault", "list", "--output", "table"}},
	{Name: "az_apim_list", Description: "List API Management services.", Command: "az", Args: []string{"apim", "list", "--output", "table"}},
	{Name: "az_cdn_profiles", Description: "List Azure CDN profiles.", Command: "az", Args: []string{"cdn", "profile", "list", "--output", "table"}},
	{Name: "az_signalr_list", Description: "List Azure SignalR services.", Command: "az", Args: []string{"signalr", "list", "--output", "table"}},
	{Name: "az_staticwebapp", Description: "List Static Web Apps.", Command: "az", Args: []string{"staticwebapp", "list", "--output", "table"}},
	{Name: "az_devops_projects", Description: "List Azure DevOps projects.", Command: "az", Args: []string{"devops", "project", "list", "--output", "table"}},

	// =========================================================================
	// CI/CD PLATFORMS
	// =========================================================================
	{Name: "circleci_pipelines", Description: "List CircleCI pipelines.", Command: "circleci", Args: []string{"pipeline", "list"}},
	{Name: "circleci_workflows", Description: "List CircleCI workflows.", Command: "circleci", Args: []string{"workflow", "list"}},
	{Name: "buildkite_pipelines", Description: "List Buildkite pipelines.", Command: "bk", Args: []string{"pipeline", "list"}},
	{Name: "drone_builds", Description: "List Drone CI builds.", Command: "drone", Args: []string{"build", "ls"}},
	{Name: "argocd_apps", Description: "List ArgoCD applications.", Command: "argocd", Args: []string{"app", "list"}},
	{Name: "argocd_sync", Description: "Show ArgoCD sync status.", Command: "argocd", Args: []string{"app", "get"}, Properties: map[string]map[string]interface{}{"app": {"type": "string"}}, Required: []string{"app"}},
	{Name: "tekton_pipelines", Description: "List Tekton pipelines.", Command: "tkn", Args: []string{"pipeline", "list"}},
	{Name: "tekton_runs", Description: "List Tekton pipeline runs.", Command: "tkn", Args: []string{"pipelinerun", "list"}},
	{Name: "concourse_pipelines", Description: "List Concourse pipelines.", Command: "fly", Args: []string{"pipelines"}},
	{Name: "jenkins_jobs", Description: "List Jenkins jobs.", Command: "jenkins-cli", Args: []string{"list-jobs"}},

	// =========================================================================
	// CONTAINER SECURITY
	// =========================================================================
	{Name: "trivy_scan", Description: "Scan container image for vulnerabilities.", Command: "trivy", Args: []string{"image", "--severity", "HIGH,CRITICAL"}, Properties: map[string]map[string]interface{}{"image": {"type": "string"}}, Required: []string{"image"}},
	{Name: "trivy_fs", Description: "Scan filesystem for vulnerabilities.", Command: "trivy", Args: []string{"fs", "."}, WorkDir: true},
	{Name: "grype_scan", Description: "Scan for vulnerabilities with Grype.", Command: "grype", Properties: map[string]map[string]interface{}{"image": {"type": "string"}}, Required: []string{"image"}},
	{Name: "syft_sbom", Description: "Generate SBOM with Syft.", Command: "syft", Properties: map[string]map[string]interface{}{"image": {"type": "string"}}, Required: []string{"image"}},
	{Name: "cosign_verify", Description: "Verify container image signature.", Command: "cosign", Args: []string{"verify"}, Properties: map[string]map[string]interface{}{"image": {"type": "string"}}, Required: []string{"image"}},
	{Name: "snyk_test", Description: "Run Snyk security test.", Command: "snyk", Args: []string{"test"}, WorkDir: true},
	{Name: "snyk_monitor", Description: "Monitor project with Snyk.", Command: "snyk", Args: []string{"monitor"}, WorkDir: true},

	// =========================================================================
	// API TOOLS
	// =========================================================================
	{Name: "grpcurl_list", Description: "List gRPC services.", Command: "grpcurl", Args: []string{"-plaintext"}, Properties: map[string]map[string]interface{}{"server": {"type": "string", "description": "host:port"}}, Required: []string{"server"}},
	{Name: "grpcurl_describe", Description: "Describe gRPC service.", Command: "grpcurl", Args: []string{"-plaintext", "describe"}, Properties: map[string]map[string]interface{}{"server": {"type": "string"}, "service": {"type": "string"}}, Required: []string{"server", "service"}},
	{Name: "protoc_compile", Description: "Compile protobuf files.", Command: "protoc", Args: []string{"--go_out=."}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "swagger_validate", Description: "Validate OpenAPI spec.", Command: "swagger", Args: []string{"validate"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "httpie_get", Description: "HTTP GET with HTTPie.", Command: "http", Args: []string{"GET"}, Properties: map[string]map[string]interface{}{"url": {"type": "string"}}, Required: []string{"url"}},

	// =========================================================================
	// DATABASE CLIs
	// =========================================================================
	{Name: "mongosh_status", Description: "MongoDB server status.", Command: "mongosh", Args: []string{"--eval", "db.serverStatus()"}},
	{Name: "mongosh_dbs", Description: "List MongoDB databases.", Command: "mongosh", Args: []string{"--eval", "show dbs"}},
	{Name: "mongosh_collections", Description: "List MongoDB collections.", Command: "mongosh", Args: []string{"--eval", "show collections"}},
	{Name: "psql_databases", Description: "List PostgreSQL databases.", Command: "psql", Args: []string{"-l"}},
	{Name: "psql_tables", Description: "List PostgreSQL tables.", Command: "psql", Args: []string{"-c", "\\dt+"}},
	{Name: "mysql_databases", Description: "List MySQL databases.", Command: "mysql", Args: []string{"-e", "SHOW DATABASES"}},
	{Name: "mysql_tables", Description: "List MySQL tables.", Command: "mysql", Args: []string{"-e", "SHOW TABLES"}, Properties: map[string]map[string]interface{}{"database": {"type": "string"}}, Required: []string{"database"}},
	{Name: "redis_ping", Description: "Ping Redis.", Command: "redis-cli", Args: []string{"ping"}},
	{Name: "redis_dbsize", Description: "Show Redis DB size.", Command: "redis-cli", Args: []string{"dbsize"}},
	{Name: "redis_slowlog", Description: "Show Redis slow queries.", Command: "redis-cli", Args: []string{"slowlog", "get", "10"}},
	{Name: "cockroach_status", Description: "CockroachDB node status.", Command: "cockroach", Args: []string{"node", "status"}},
	{Name: "influxdb_databases", Description: "List InfluxDB databases.", Command: "influx", Args: []string{"-execute", "SHOW DATABASES"}},

	// =========================================================================
	// SERVICE MESH
	// =========================================================================
	{Name: "istio_proxy_status", Description: "Show Istio proxy status.", Command: "istioctl", Args: []string{"proxy-status"}},
	{Name: "istio_analyze", Description: "Analyze Istio config.", Command: "istioctl", Args: []string{"analyze"}},
	{Name: "linkerd_check", Description: "Linkerd health check.", Command: "linkerd", Args: []string{"check"}},
	{Name: "linkerd_stat", Description: "Linkerd traffic stats.", Command: "linkerd", Args: []string{"stat", "deploy"}},

	// =========================================================================
	// OBSERVABILITY
	// =========================================================================
	{Name: "otel_status", Description: "OpenTelemetry collector status.", Command: "otelcol", Args: []string{"--version"}},
	{Name: "jaeger_status", Description: "Jaeger tracing status.", Command: "curl", Args: []string{"-s", "localhost:16686/api/services"}},
	{Name: "zipkin_services", Description: "List Zipkin services.", Command: "curl", Args: []string{"-s", "localhost:9411/api/v2/services"}},

	// =========================================================================
	// FEATURE FLAGS
	// =========================================================================
	{Name: "unleash_features", Description: "List Unleash feature flags.", Command: "curl", Args: []string{"-s", "localhost:4242/api/client/features"}},

	// =========================================================================
	// MORE COMPRESSION
	// =========================================================================
	{Name: "gzip_compress", Description: "Gzip compress a file.", Command: "gzip", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "gzip_decompress", Description: "Gzip decompress a file.", Command: "gunzip", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "bzip2_compress", Description: "Bzip2 compress a file.", Command: "bzip2", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "xz_compress", Description: "XZ compress a file.", Command: "xz", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "zstd_compress", Description: "Zstd compress a file.", Command: "zstd", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "zstd_decompress", Description: "Zstd decompress a file.", Command: "zstd", Args: []string{"-d"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},

	// =========================================================================
	// MORE LANGUAGES
	// =========================================================================
	// OCaml
	{Name: "ocaml_version", Description: "Show OCaml version.", Command: "ocaml", Args: []string{"-version"}},
	{Name: "opam_list", Description: "List OCaml packages.", Command: "opam", Args: []string{"list"}},
	{Name: "dune_build", Description: "Build OCaml with dune.", Command: "dune", Args: []string{"build"}, WorkDir: true},
	{Name: "dune_test", Description: "Test OCaml with dune.", Command: "dune", Args: []string{"test"}, WorkDir: true},
	// Nim
	{Name: "nim_version", Description: "Show Nim version.", Command: "nim", Args: []string{"--version"}},
	{Name: "nimble_install", Description: "Install Nim package.", Command: "nimble", Args: []string{"install"}, Properties: map[string]map[string]interface{}{"package": {"type": "string"}}, Required: []string{"package"}},
	// V
	{Name: "v_version", Description: "Show V version.", Command: "v", Args: []string{"version"}},
	{Name: "v_build", Description: "Build V project.", Command: "v", Args: []string{"."}, WorkDir: true},
	// Crystal
	{Name: "crystal_version", Description: "Show Crystal version.", Command: "crystal", Args: []string{"version"}},
	{Name: "crystal_build", Description: "Build Crystal project.", Command: "crystal", Args: []string{"build"}, WorkDir: true},
	{Name: "shards_install", Description: "Install Crystal dependencies.", Command: "shards", Args: []string{"install"}, WorkDir: true},
	// Kotlin
	{Name: "kotlin_version", Description: "Show Kotlin version.", Command: "kotlin", Args: []string{"-version"}},
	{Name: "kotlinc_compile", Description: "Compile Kotlin.", Command: "kotlinc", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	// Clojure
	{Name: "clojure_version", Description: "Show Clojure version.", Command: "clojure", Args: []string{"--version"}},
	{Name: "lein_deps", Description: "Get Leiningen dependencies.", Command: "lein", Args: []string{"deps", ":tree"}, WorkDir: true},
	{Name: "lein_test", Description: "Run Leiningen tests.", Command: "lein", Args: []string{"test"}, WorkDir: true},
	// Erlang
	{Name: "erl_version", Description: "Show Erlang version.", Command: "erl", Args: []string{"-eval", "erlang:display(erlang:system_info(otp_release)), halt().", "-noshell"}},
	{Name: "rebar3_compile", Description: "Compile Erlang with rebar3.", Command: "rebar3", Args: []string{"compile"}, WorkDir: true},
	// F#
	{Name: "fsharp_version", Description: "Show F# version.", Command: "dotnet", Args: []string{"fsi", "--version"}},
	// Groovy
	{Name: "groovy_version", Description: "Show Groovy version.", Command: "groovy", Args: []string{"--version"}},
	// Dart (beyond Flutter)
	{Name: "dart_version", Description: "Show Dart version.", Command: "dart", Args: []string{"--version"}},
	{Name: "dart_analyze", Description: "Analyze Dart code.", Command: "dart", Args: []string{"analyze"}, WorkDir: true},
	{Name: "dart_test", Description: "Run Dart tests.", Command: "dart", Args: []string{"test"}, WorkDir: true},
	{Name: "dart_format", Description: "Format Dart code.", Command: "dart", Args: []string{"format", "."}, WorkDir: true},

	// =========================================================================
	// TERRAFORM ADVANCED
	// =========================================================================
	{Name: "tf_fmt", Description: "Format Terraform files.", Command: "terraform", Args: []string{"fmt", "-recursive"}, WorkDir: true},
	{Name: "tf_graph", Description: "Generate Terraform dependency graph.", Command: "terraform", Args: []string{"graph"}, WorkDir: true},
	{Name: "tf_providers", Description: "List Terraform providers.", Command: "terraform", Args: []string{"providers"}, WorkDir: true},
	{Name: "tf_workspace_list", Description: "List Terraform workspaces.", Command: "terraform", Args: []string{"workspace", "list"}, WorkDir: true},
	{Name: "tf_show", Description: "Show Terraform state/plan.", Command: "terraform", Args: []string{"show"}, WorkDir: true},
	{Name: "tf_taint", Description: "Taint a Terraform resource.", Command: "terraform", Args: []string{"taint"}, Properties: map[string]map[string]interface{}{"resource": {"type": "string"}}, Required: []string{"resource"}, WorkDir: true},
	{Name: "tf_import", Description: "Import existing resource into Terraform.", Command: "terraform", Args: []string{"import"}, Properties: map[string]map[string]interface{}{"address": {"type": "string"}, "id": {"type": "string"}}, Required: []string{"address", "id"}, WorkDir: true},

	// =========================================================================
	// KUBERNETES ADVANCED
	// =========================================================================
	{Name: "k8s_configmaps", Description: "List Kubernetes ConfigMaps.", Command: "kubectl", Args: []string{"get", "configmaps", "--all-namespaces"}},
	{Name: "k8s_secrets_list", Description: "List Kubernetes Secrets.", Command: "kubectl", Args: []string{"get", "secrets", "--all-namespaces"}},
	{Name: "k8s_ingress_list", Description: "List Kubernetes Ingresses.", Command: "kubectl", Args: []string{"get", "ingress", "--all-namespaces"}},
	{Name: "k8s_pv_list", Description: "List Persistent Volumes.", Command: "kubectl", Args: []string{"get", "pv"}},
	{Name: "k8s_pvc_list", Description: "List Persistent Volume Claims.", Command: "kubectl", Args: []string{"get", "pvc", "--all-namespaces"}},
	{Name: "k8s_nodes", Description: "List Kubernetes nodes.", Command: "kubectl", Args: []string{"get", "nodes", "-o", "wide"}},
	{Name: "k8s_services_list", Description: "List Kubernetes services.", Command: "kubectl", Args: []string{"get", "services", "--all-namespaces"}},
	{Name: "k8s_daemonsets", Description: "List Kubernetes DaemonSets.", Command: "kubectl", Args: []string{"get", "daemonsets", "--all-namespaces"}},
	{Name: "k8s_statefulsets", Description: "List StatefulSets.", Command: "kubectl", Args: []string{"get", "statefulsets", "--all-namespaces"}},
	{Name: "k8s_jobs", Description: "List Kubernetes Jobs.", Command: "kubectl", Args: []string{"get", "jobs", "--all-namespaces"}},
	{Name: "k8s_cronjobs", Description: "List Kubernetes CronJobs.", Command: "kubectl", Args: []string{"get", "cronjobs", "--all-namespaces"}},
	{Name: "k8s_hpa", Description: "List Horizontal Pod Autoscalers.", Command: "kubectl", Args: []string{"get", "hpa", "--all-namespaces"}},
	{Name: "k8s_networkpolicies", Description: "List NetworkPolicies.", Command: "kubectl", Args: []string{"get", "networkpolicies", "--all-namespaces"}},
	{Name: "k8s_rbac_roles", Description: "List RBAC ClusterRoles.", Command: "kubectl", Args: []string{"get", "clusterroles"}},
	{Name: "k8s_rbac_bindings", Description: "List RBAC ClusterRoleBindings.", Command: "kubectl", Args: []string{"get", "clusterrolebindings"}},
	{Name: "k8s_service_accounts", Description: "List service accounts.", Command: "kubectl", Args: []string{"get", "serviceaccounts", "--all-namespaces"}},
	{Name: "k8s_resource_quotas", Description: "List resource quotas.", Command: "kubectl", Args: []string{"get", "resourcequotas", "--all-namespaces"}},
	{Name: "k8s_limit_ranges", Description: "List LimitRanges.", Command: "kubectl", Args: []string{"get", "limitranges", "--all-namespaces"}},
	{Name: "k8s_endpoints", Description: "List endpoints.", Command: "kubectl", Args: []string{"get", "endpoints", "--all-namespaces"}},
	{Name: "k8s_cluster_info", Description: "Show cluster info.", Command: "kubectl", Args: []string{"cluster-info"}},
	{Name: "k8s_api_resources", Description: "List all API resources.", Command: "kubectl", Args: []string{"api-resources"}},
	{Name: "k8s_api_versions", Description: "List API versions.", Command: "kubectl", Args: []string{"api-versions"}},
	{Name: "k8s_rollout_status", Description: "Show deployment rollout status.", Command: "kubectl", Args: []string{"rollout", "status", "deployment"}, Properties: map[string]map[string]interface{}{"deployment": {"type": "string"}}, Required: []string{"deployment"}},
	{Name: "k8s_rollout_history", Description: "Show deployment rollout history.", Command: "kubectl", Args: []string{"rollout", "history", "deployment"}, Properties: map[string]map[string]interface{}{"deployment": {"type": "string"}}, Required: []string{"deployment"}},
	{Name: "k8s_scale", Description: "Scale a deployment.", Command: "kubectl", Args: []string{"scale", "deployment"}, Properties: map[string]map[string]interface{}{"deployment": {"type": "string"}, "replicas": {"type": "string"}}, Required: []string{"deployment", "replicas"}},

	// =========================================================================
	// ADDITIONAL LINUX TOOLS
	// =========================================================================
	{Name: "sysctl_list", Description: "List kernel parameters.", Command: "sysctl", Args: []string{"-a"}},
	{Name: "ulimit_show", Description: "Show user limits.", Command: "ulimit", Args: []string{"-a"}},
	{Name: "crontab_list_root", Description: "List root crontab.", Command: "sudo", Args: []string{"crontab", "-l"}},
	{Name: "at_queue", Description: "List scheduled at jobs.", Command: "atq"},
	{Name: "ps_tree", Description: "Show process tree.", Command: "pstree"},
	{Name: "kill_by_name", Description: "Kill process by name.", Command: "pkill", Properties: map[string]map[string]interface{}{"name": {"type": "string"}}, Required: []string{"name"}},
	{Name: "nice_process", Description: "Run command with nice value.", Command: "nice", Args: []string{"-n", "10"}, Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}},
	{Name: "nproc_count", Description: "Show number of CPU cores.", Command: "nproc"},
	{Name: "arch_info", Description: "Show CPU architecture.", Command: "arch"},
	{Name: "locale_info", Description: "Show locale settings.", Command: "locale"},
	{Name: "timedatectl", Description: "Show time and date settings.", Command: "timedatectl"},
	{Name: "hostnamectl", Description: "Show hostname info.", Command: "hostnamectl"},
	{Name: "loginctl_sessions", Description: "List login sessions.", Command: "loginctl", Args: []string{"list-sessions"}},
	{Name: "lsmod", Description: "List loaded kernel modules.", Command: "lsmod"},
	{Name: "modinfo", Description: "Show kernel module info.", Command: "modinfo", Properties: map[string]map[string]interface{}{"module": {"type": "string"}}, Required: []string{"module"}},
	{Name: "dmidecode_brief", Description: "Show hardware info (BIOS/motherboard).", Command: "sudo", Args: []string{"dmidecode", "--type", "system"}},
	{Name: "lshw_short", Description: "Show hardware summary.", Command: "sudo", Args: []string{"lshw", "-short"}},

	// =========================================================================
	// NETWORK DEBUGGING (MORE)
	// =========================================================================
	{Name: "tcpdump_brief", Description: "Capture network packets (brief).", Command: "sudo", Args: []string{"tcpdump", "-c", "20", "-i", "any"}},
	{Name: "ethtool_info", Description: "Show network interface info.", Command: "ethtool", Properties: map[string]map[string]interface{}{"interface": {"type": "string", "description": "e.g. eth0"}}, Required: []string{"interface"}},
	{Name: "iwlist_scan", Description: "Scan WiFi networks.", Command: "sudo", Args: []string{"iwlist", "wlan0", "scan"}},
	{Name: "nmcli_connections", Description: "List NetworkManager connections.", Command: "nmcli", Args: []string{"connection", "show"}},
	{Name: "nmcli_devices", Description: "List NetworkManager devices.", Command: "nmcli", Args: []string{"device", "status"}},
	{Name: "resolvectl_status", Description: "Show DNS resolver status.", Command: "resolvectl", Args: []string{"status"}},
	{Name: "ip_neigh", Description: "Show ARP/neighbor table.", Command: "ip", Args: []string{"neigh", "show"}},
	{Name: "bridge_fdb", Description: "Show bridge forwarding database.", Command: "bridge", Args: []string{"fdb", "show"}},
	{Name: "iftop_snapshot", Description: "Network bandwidth by connection.", Command: "sudo", Args: []string{"iftop", "-t", "-s", "5", "-p"}},
	{Name: "nethogs_snapshot", Description: "Network bandwidth by process.", Command: "sudo", Args: []string{"nethogs", "-t", "-c", "5"}},

	// =========================================================================
	// PACKAGE BUILDING
	// =========================================================================
	{Name: "fpm_build", Description: "Build package with fpm.", Command: "fpm", Properties: map[string]map[string]interface{}{"args": {"type": "string", "description": "fpm arguments"}}, Required: []string{"args"}},
	{Name: "nfpm_package", Description: "Package with nfpm.", Command: "nfpm", Args: []string{"package"}, WorkDir: true},
	{Name: "goreleaser_check", Description: "Check GoReleaser config.", Command: "goreleaser", Args: []string{"check"}, WorkDir: true},
	{Name: "goreleaser_build", Description: "Build with GoReleaser.", Command: "goreleaser", Args: []string{"build", "--snapshot", "--clean"}, WorkDir: true},
	{Name: "electron_builder", Description: "Build Electron app.", Command: "npx", Args: []string{"electron-builder"}, WorkDir: true},
	{Name: "tauri_build", Description: "Build Tauri app.", Command: "npx", Args: []string{"tauri", "build"}, WorkDir: true},
	{Name: "wails_build", Description: "Build Wails app.", Command: "wails", Args: []string{"build"}, WorkDir: true},

	// =========================================================================
	// DATA SCIENCE
	// =========================================================================
	{Name: "jupyter_list", Description: "List Jupyter notebooks.", Command: "jupyter", Args: []string{"notebook", "list"}},
	{Name: "jupyter_kernels", Description: "List Jupyter kernels.", Command: "jupyter", Args: []string{"kernelspec", "list"}},
	{Name: "conda_list", Description: "List Conda packages.", Command: "conda", Args: []string{"list"}},
	{Name: "conda_envs", Description: "List Conda environments.", Command: "conda", Args: []string{"env", "list"}},
	{Name: "pip_freeze", Description: "Freeze pip requirements.", Command: "pip", Args: []string{"freeze"}, WorkDir: true},
	{Name: "poetry_show", Description: "List Poetry dependencies.", Command: "poetry", Args: []string{"show"}, WorkDir: true},
	{Name: "poetry_install", Description: "Install Poetry dependencies.", Command: "poetry", Args: []string{"install"}, WorkDir: true},
	{Name: "pdm_list", Description: "List PDM dependencies.", Command: "pdm", Args: []string{"list"}, WorkDir: true},
	{Name: "uv_pip_list", Description: "List uv/pip packages.", Command: "uv", Args: []string{"pip", "list"}, WorkDir: true},
	{Name: "pipx_list", Description: "List pipx apps.", Command: "pipx", Args: []string{"list"}},

	// =========================================================================
	// CROSS-PLATFORM TOOLS
	// =========================================================================
	{Name: "asdf_list", Description: "List asdf-managed versions.", Command: "asdf", Args: []string{"list"}},
	{Name: "asdf_current", Description: "Show current asdf versions.", Command: "asdf", Args: []string{"current"}},
	{Name: "mise_list", Description: "List mise (rtx) managed tools.", Command: "mise", Args: []string{"list"}},
	{Name: "mise_current", Description: "Show current mise versions.", Command: "mise", Args: []string{"current"}},
	{Name: "nvm_list", Description: "List nvm-managed Node versions.", Command: "nvm", Args: []string{"list"}},
	{Name: "rbenv_versions", Description: "List rbenv Ruby versions.", Command: "rbenv", Args: []string{"versions"}},
	{Name: "pyenv_versions", Description: "List pyenv Python versions.", Command: "pyenv", Args: []string{"versions"}},
	{Name: "rustup_show", Description: "Show Rust toolchains.", Command: "rustup", Args: []string{"show"}},
	{Name: "sdkman_list", Description: "List SDKMAN installs.", Command: "sdk", Args: []string{"list"}},

	// =========================================================================
	// WASM
	// =========================================================================
	{Name: "wasm_pack_build", Description: "Build WASM with wasm-pack.", Command: "wasm-pack", Args: []string{"build"}, WorkDir: true},
	{Name: "wasmtime_run", Description: "Run WASM module.", Command: "wasmtime", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "wasmer_run", Description: "Run WASM with Wasmer.", Command: "wasmer", Args: []string{"run"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},

	// =========================================================================
	// MONITORING AGENTS
	// =========================================================================
	{Name: "datadog_status", Description: "Datadog agent status.", Command: "datadog-agent", Args: []string{"status"}},
	{Name: "datadog_check", Description: "Run Datadog agent check.", Command: "datadog-agent", Args: []string{"check"}, Properties: map[string]map[string]interface{}{"check": {"type": "string"}}, Required: []string{"check"}},
	{Name: "newrelic_status", Description: "New Relic agent status.", Command: "newrelic", Args: []string{"agent", "status"}},
	{Name: "telegraf_test", Description: "Test Telegraf config.", Command: "telegraf", Args: []string{"--test"}},
	{Name: "fluentd_status", Description: "Fluentd status.", Command: "fluentd", Args: []string{"--dry-run"}},
	{Name: "vector_top", Description: "Vector observability top.", Command: "vector", Args: []string{"top"}},
	{Name: "collectd_status", Description: "Collectd status.", Command: "collectdctl", Args: []string{"listval"}},

	// =========================================================================
	// FRONTEND FRAMEWORKS
	// =========================================================================
	{Name: "vite_build", Description: "Build with Vite.", Command: "npx", Args: []string{"vite", "build"}, WorkDir: true},
	{Name: "vite_preview", Description: "Preview Vite build.", Command: "npx", Args: []string{"vite", "preview"}, WorkDir: true},
	{Name: "webpack_build", Description: "Build with Webpack.", Command: "npx", Args: []string{"webpack", "--mode", "production"}, WorkDir: true},
	{Name: "parcel_build", Description: "Build with Parcel.", Command: "npx", Args: []string{"parcel", "build"}, WorkDir: true},
	{Name: "esbuild_bundle", Description: "Bundle with esbuild.", Command: "npx", Args: []string{"esbuild", "--bundle"}, WorkDir: true},
	{Name: "rollup_build", Description: "Build with Rollup.", Command: "npx", Args: []string{"rollup", "-c"}, WorkDir: true},
	{Name: "turbo_build", Description: "Build with Turborepo.", Command: "npx", Args: []string{"turbo", "build"}, WorkDir: true},
	{Name: "turbo_test", Description: "Test with Turborepo.", Command: "npx", Args: []string{"turbo", "test"}, WorkDir: true},
	{Name: "turbo_lint", Description: "Lint with Turborepo.", Command: "npx", Args: []string{"turbo", "lint"}, WorkDir: true},
	{Name: "nx_build", Description: "Build with Nx.", Command: "npx", Args: []string{"nx", "build"}, WorkDir: true},
	{Name: "nx_test", Description: "Test with Nx.", Command: "npx", Args: []string{"nx", "test"}, WorkDir: true},
	{Name: "lerna_list", Description: "List Lerna packages.", Command: "npx", Args: []string{"lerna", "list"}, WorkDir: true},
	{Name: "changeset_status", Description: "Check changesets.", Command: "npx", Args: []string{"changeset", "status"}, WorkDir: true},
	{Name: "storybook_build", Description: "Build Storybook.", Command: "npx", Args: []string{"storybook", "build"}, WorkDir: true},
	{Name: "playwright_test", Description: "Run Playwright tests.", Command: "npx", Args: []string{"playwright", "test"}, WorkDir: true},
	{Name: "cypress_run", Description: "Run Cypress tests.", Command: "npx", Args: []string{"cypress", "run"}, WorkDir: true},
	{Name: "puppeteer_version", Description: "Show Puppeteer version.", Command: "npx", Args: []string{"puppeteer", "--version"}},

	// =========================================================================
	// MOBILE FRAMEWORK EXTRAS
	// =========================================================================
	{Name: "react_native_info", Description: "React Native env info.", Command: "npx", Args: []string{"react-native", "info"}},
	{Name: "react_native_doctor", Description: "React Native doctor.", Command: "npx", Args: []string{"react-native", "doctor"}},
	{Name: "expo_doctor", Description: "Expo doctor.", Command: "npx", Args: []string{"expo", "doctor"}, WorkDir: true},
	{Name: "expo_prebuild", Description: "Expo prebuild.", Command: "npx", Args: []string{"expo", "prebuild"}, WorkDir: true},
	{Name: "capacitor_sync", Description: "Capacitor sync.", Command: "npx", Args: []string{"cap", "sync"}, WorkDir: true},
	{Name: "ionic_info", Description: "Ionic project info.", Command: "ionic", Args: []string{"info"}, WorkDir: true},
	{Name: "cordova_info", Description: "Cordova project info.", Command: "cordova", Args: []string{"info"}, WorkDir: true},

	// =========================================================================
	// BACKEND FRAMEWORKS
	// =========================================================================
	{Name: "django_check", Description: "Django system check.", Command: "python3", Args: []string{"manage.py", "check"}, WorkDir: true},
	{Name: "django_migrations", Description: "Django show migrations.", Command: "python3", Args: []string{"manage.py", "showmigrations"}, WorkDir: true},
	{Name: "django_migrate", Description: "Django run migrations.", Command: "python3", Args: []string{"manage.py", "migrate"}, WorkDir: true},
	{Name: "django_shell", Description: "Django shell command.", Command: "python3", Args: []string{"manage.py", "shell", "-c"}, Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}, WorkDir: true},
	{Name: "flask_routes", Description: "Show Flask routes.", Command: "flask", Args: []string{"routes"}, WorkDir: true},
	{Name: "fastapi_openapi", Description: "Get FastAPI OpenAPI schema.", Command: "curl", Args: []string{"-s", "localhost:8000/openapi.json"}},
	{Name: "spring_actuator_health", Description: "Spring Boot actuator health.", Command: "curl", Args: []string{"-s", "localhost:8080/actuator/health"}},
	{Name: "spring_actuator_info", Description: "Spring Boot actuator info.", Command: "curl", Args: []string{"-s", "localhost:8080/actuator/info"}},
	{Name: "nestjs_info", Description: "NestJS project info.", Command: "npx", Args: []string{"nest", "info"}, WorkDir: true},
	{Name: "strapi_routes", Description: "Show Strapi routes.", Command: "npx", Args: []string{"strapi", "routes:list"}, WorkDir: true},
	{Name: "payload_generate", Description: "Generate PayloadCMS types.", Command: "npx", Args: []string{"payload", "generate:types"}, WorkDir: true},
	{Name: "phoenix_routes", Description: "Show Phoenix routes.", Command: "mix", Args: []string{"phx.routes"}, WorkDir: true},
	{Name: "phoenix_migrate", Description: "Run Phoenix migrations.", Command: "mix", Args: []string{"ecto.migrate"}, WorkDir: true},

	// =========================================================================
	// STATIC SITE GENERATORS
	// =========================================================================
	{Name: "hugo_build", Description: "Build Hugo site.", Command: "hugo", WorkDir: true},
	{Name: "hugo_server", Description: "Start Hugo dev server.", Command: "hugo", Args: []string{"server"}, WorkDir: true},
	{Name: "gatsby_build", Description: "Build Gatsby site.", Command: "npx", Args: []string{"gatsby", "build"}, WorkDir: true},
	{Name: "astro_build", Description: "Build Astro site.", Command: "npx", Args: []string{"astro", "build"}, WorkDir: true},
	{Name: "eleventy_build", Description: "Build 11ty site.", Command: "npx", Args: []string{"@11ty/eleventy"}, WorkDir: true},
	{Name: "jekyll_build", Description: "Build Jekyll site.", Command: "jekyll", Args: []string{"build"}, WorkDir: true},
	{Name: "hexo_generate", Description: "Generate Hexo site.", Command: "npx", Args: []string{"hexo", "generate"}, WorkDir: true},
	{Name: "docusaurus_build", Description: "Build Docusaurus site.", Command: "npx", Args: []string{"docusaurus", "build"}, WorkDir: true},
	{Name: "nextra_build", Description: "Build Nextra site.", Command: "npx", Args: []string{"next", "build"}, WorkDir: true},
	{Name: "mintlify_build", Description: "Build Mintlify docs.", Command: "npx", Args: []string{"mintlify", "build"}, WorkDir: true},

	// =========================================================================
	// ORM & DATABASE TOOLS
	// =========================================================================
	{Name: "typeorm_migrate", Description: "TypeORM run migrations.", Command: "npx", Args: []string{"typeorm", "migration:run"}, WorkDir: true},
	{Name: "typeorm_generate", Description: "TypeORM generate migration.", Command: "npx", Args: []string{"typeorm", "migration:generate"}, WorkDir: true},
	{Name: "sequelize_status", Description: "Sequelize migration status.", Command: "npx", Args: []string{"sequelize-cli", "db:migrate:status"}, WorkDir: true},
	{Name: "sequelize_migrate", Description: "Sequelize run migrations.", Command: "npx", Args: []string{"sequelize-cli", "db:migrate"}, WorkDir: true},
	{Name: "knex_migrate", Description: "Knex run migrations.", Command: "npx", Args: []string{"knex", "migrate:latest"}, WorkDir: true},
	{Name: "knex_status", Description: "Knex migration status.", Command: "npx", Args: []string{"knex", "migrate:status"}, WorkDir: true},
	{Name: "goose_status", Description: "Goose migration status.", Command: "goose", Args: []string{"status"}, WorkDir: true},
	{Name: "goose_up", Description: "Goose run migrations.", Command: "goose", Args: []string{"up"}, WorkDir: true},
	{Name: "alembic_heads", Description: "Alembic migration heads.", Command: "alembic", Args: []string{"heads"}, WorkDir: true},
	{Name: "alembic_current", Description: "Alembic current version.", Command: "alembic", Args: []string{"current"}, WorkDir: true},
	{Name: "alembic_upgrade", Description: "Alembic upgrade to head.", Command: "alembic", Args: []string{"upgrade", "head"}, WorkDir: true},
	{Name: "flyway_info", Description: "Flyway migration info.", Command: "flyway", Args: []string{"info"}, WorkDir: true},
	{Name: "flyway_migrate", Description: "Flyway run migrations.", Command: "flyway", Args: []string{"migrate"}, WorkDir: true},
	{Name: "liquibase_status", Description: "Liquibase status.", Command: "liquibase", Args: []string{"status"}, WorkDir: true},
	{Name: "dbmate_status", Description: "dbmate migration status.", Command: "dbmate", Args: []string{"status"}, WorkDir: true},
	{Name: "dbmate_up", Description: "dbmate run migrations.", Command: "dbmate", Args: []string{"up"}, WorkDir: true},

	// =========================================================================
	// TASK RUNNERS
	// =========================================================================
	{Name: "just_list", Description: "List just recipes.", Command: "just", Args: []string{"--list"}, WorkDir: true},
	{Name: "task_list", Description: "List Taskfile tasks.", Command: "task", Args: []string{"--list"}, WorkDir: true},
	{Name: "invoke_list", Description: "List invoke tasks (Python).", Command: "invoke", Args: []string{"--list"}, WorkDir: true},
	{Name: "jake_list", Description: "List Jake tasks.", Command: "npx", Args: []string{"jake", "-T"}, WorkDir: true},
	{Name: "rake_list", Description: "List Rake tasks.", Command: "rake", Args: []string{"-T"}, WorkDir: true},
	{Name: "gulp_list", Description: "List Gulp tasks.", Command: "npx", Args: []string{"gulp", "--tasks"}, WorkDir: true},
	{Name: "grunt_list", Description: "List Grunt tasks.", Command: "npx", Args: []string{"grunt", "--help"}, WorkDir: true},

	// =========================================================================
	// LINTERS (ADDITIONAL)
	// =========================================================================
	{Name: "shellcheck_lint", Description: "Lint shell scripts.", Command: "shellcheck", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "hadolint_check", Description: "Lint Dockerfile.", Command: "hadolint", Properties: map[string]map[string]interface{}{"file": {"type": "string", "description": "Dockerfile path"}}, Required: []string{"file"}},
	{Name: "yamllint_check", Description: "Lint YAML files.", Command: "yamllint", Args: []string{"."}, WorkDir: true},
	{Name: "jsonlint_check", Description: "Lint JSON file.", Command: "jsonlint", Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	{Name: "markdownlint_check", Description: "Lint Markdown files.", Command: "markdownlint", Args: []string{"."}, WorkDir: true},
	{Name: "htmlhint_check", Description: "Lint HTML files.", Command: "npx", Args: []string{"htmlhint"}, WorkDir: true},
	{Name: "stylelint_check", Description: "Lint CSS/SCSS.", Command: "npx", Args: []string{"stylelint", "**/*.css"}, WorkDir: true},
	{Name: "commitlint_check", Description: "Lint commit messages.", Command: "npx", Args: []string{"commitlint", "--from", "HEAD~1"}, WorkDir: true},
	{Name: "actionlint_check", Description: "Lint GitHub Actions workflows.", Command: "actionlint", WorkDir: true},
	{Name: "editorconfig_check", Description: "Check EditorConfig compliance.", Command: "npx", Args: []string{"editorconfig-checker"}, WorkDir: true},
	{Name: "biome_check", Description: "Lint/format with Biome.", Command: "npx", Args: []string{"biome", "check"}, WorkDir: true},
	{Name: "oxlint_check", Description: "Lint with OxLint.", Command: "npx", Args: []string{"oxlint"}, WorkDir: true},
	{Name: "dprint_check", Description: "Format check with dprint.", Command: "dprint", Args: []string{"check"}, WorkDir: true},
	{Name: "taplo_check", Description: "Lint TOML files.", Command: "taplo", Args: []string{"check"}, WorkDir: true},
	{Name: "sqlfluff_lint", Description: "Lint SQL with sqlfluff.", Command: "sqlfluff", Args: []string{"lint"}, WorkDir: true},
	{Name: "tflint_check", Description: "Lint Terraform with tflint.", Command: "tflint", WorkDir: true},
	{Name: "checkov_scan", Description: "Scan IaC with Checkov.", Command: "checkov", Args: []string{"-d", "."}, WorkDir: true},

	// =========================================================================
	// TEST FRAMEWORKS (MORE)
	// =========================================================================
	{Name: "mocha_run", Description: "Run Mocha tests.", Command: "npx", Args: []string{"mocha"}, WorkDir: true},
	{Name: "ava_run", Description: "Run AVA tests.", Command: "npx", Args: []string{"ava"}, WorkDir: true},
	{Name: "tap_run", Description: "Run TAP tests.", Command: "npx", Args: []string{"tap"}, WorkDir: true},
	{Name: "unittest_run", Description: "Run Python unittest.", Command: "python3", Args: []string{"-m", "unittest", "discover"}, WorkDir: true},
	{Name: "nose2_run", Description: "Run nose2 tests.", Command: "nose2", WorkDir: true},
	{Name: "cargo_nextest", Description: "Run Rust tests with nextest.", Command: "cargo", Args: []string{"nextest", "run"}, WorkDir: true},
	{Name: "go_fuzz", Description: "Run Go fuzz tests.", Command: "go", Args: []string{"test", "-fuzz=."}, WorkDir: true},
	{Name: "minitest_run", Description: "Run Ruby minitest.", Command: "ruby", Args: []string{"-Ilib:test"}, WorkDir: true},
	{Name: "catch2_run", Description: "Run Catch2 C++ tests.", Command: "ctest", Args: []string{"--test-dir", "build"}, WorkDir: true},
	{Name: "pytest_markers", Description: "List pytest markers.", Command: "pytest", Args: []string{"--markers"}, WorkDir: true},
	{Name: "jest_coverage", Description: "Jest with coverage.", Command: "npx", Args: []string{"jest", "--coverage"}, WorkDir: true},
	{Name: "vitest_coverage", Description: "Vitest with coverage.", Command: "npx", Args: []string{"vitest", "run", "--coverage"}, WorkDir: true},

	// =========================================================================
	// API/SCHEMA GENERATION
	// =========================================================================
	{Name: "openapi_gen", Description: "Generate from OpenAPI spec.", Command: "npx", Args: []string{"openapi-generator-cli", "generate"}, WorkDir: true},
	{Name: "graphql_codegen", Description: "Run GraphQL Code Generator.", Command: "npx", Args: []string{"graphql-codegen"}, WorkDir: true},
	{Name: "buf_lint", Description: "Lint protobuf with buf.", Command: "buf", Args: []string{"lint"}, WorkDir: true},
	{Name: "buf_generate", Description: "Generate from protobuf with buf.", Command: "buf", Args: []string{"generate"}, WorkDir: true},
	{Name: "quicktype_gen", Description: "Generate types from JSON.", Command: "npx", Args: []string{"quicktype"}, WorkDir: true},
	{Name: "zod_to_ts", Description: "Generate TypeScript from Zod.", Command: "npx", Args: []string{"zod-to-ts"}, WorkDir: true},
	{Name: "json_schema_gen", Description: "Generate JSON schema.", Command: "npx", Args: []string{"json-schema-generator"}, WorkDir: true},

	// =========================================================================
	// FINAL BATCH — MISCELLANEOUS DEVELOPER TOOLS
	// =========================================================================
	// Git hooks
	{Name: "husky_install", Description: "Install Husky git hooks.", Command: "npx", Args: []string{"husky", "install"}, WorkDir: true},
	{Name: "lefthook_install", Description: "Install Lefthook git hooks.", Command: "lefthook", Args: []string{"install"}, WorkDir: true},
	{Name: "pre_commit_run", Description: "Run pre-commit hooks.", Command: "pre-commit", Args: []string{"run", "--all-files"}, WorkDir: true},
	// Formatters
	{Name: "swiftformat_run", Description: "Format Swift code.", Command: "swiftformat", Args: []string{"."}, WorkDir: true},
	{Name: "scalafmt_run", Description: "Format Scala code.", Command: "scalafmt", WorkDir: true},
	{Name: "ktlint_run", Description: "Lint/format Kotlin.", Command: "ktlint", WorkDir: true},
	{Name: "google_java_format", Description: "Format Java with google-java-format.", Command: "google-java-format", Args: []string{"-i"}, Properties: map[string]map[string]interface{}{"file": {"type": "string"}}, Required: []string{"file"}},
	// Dependency graph
	{Name: "npm_ls_tree", Description: "npm dependency tree.", Command: "npm", Args: []string{"ls", "--all"}, WorkDir: true},
	{Name: "pip_pipdeptree", Description: "Python dependency tree.", Command: "pipdeptree"},
	{Name: "go_mod_why", Description: "Explain why Go module is needed.", Command: "go", Args: []string{"mod", "why"}, Properties: map[string]map[string]interface{}{"module": {"type": "string"}}, Required: []string{"module"}, WorkDir: true},
	// System cleanup
	{Name: "docker_prune", Description: "Docker system prune (dry-run info).", Command: "docker", Args: []string{"system", "df"}},
	{Name: "docker_volume_ls", Description: "List Docker volumes.", Command: "docker", Args: []string{"volume", "ls"}},
	{Name: "docker_network_ls", Description: "List Docker networks.", Command: "docker", Args: []string{"network", "ls"}},
	{Name: "npm_cache_clean", Description: "Show npm cache info.", Command: "npm", Args: []string{"cache", "ls"}},
	{Name: "brew_cleanup_dry", Description: "Homebrew cleanup dry run.", Command: "brew", Args: []string{"cleanup", "-n"}},
	{Name: "pip_cache_info", Description: "Show pip cache info.", Command: "pip", Args: []string{"cache", "info"}},
	{Name: "go_clean_cache", Description: "Show Go cache size.", Command: "go", Args: []string{"clean", "-cache", "-n"}, WorkDir: true},
	// Tunneling
	{Name: "ngrok_status", Description: "Show ngrok tunnels.", Command: "curl", Args: []string{"-s", "localhost:4040/api/tunnels"}},
	{Name: "cloudflared_status", Description: "Cloudflared tunnel status.", Command: "cloudflared", Args: []string{"tunnel", "list"}},
	{Name: "bore_version", Description: "Show bore tunnel version.", Command: "bore", Args: []string{"--version"}},
	{Name: "localtunnel_version", Description: "Show localtunnel version.", Command: "npx", Args: []string{"localtunnel", "--version"}},
	// Version managers
	{Name: "fnm_list", Description: "List fnm Node versions.", Command: "fnm", Args: []string{"list"}},
	{Name: "volta_list", Description: "List Volta tools.", Command: "volta", Args: []string{"list"}},
	{Name: "goenv_versions", Description: "List goenv Go versions.", Command: "goenv", Args: []string{"versions"}},
	// Misc dev utilities
	{Name: "tokei_stats", Description: "Count lines of code with tokei.", Command: "tokei", WorkDir: true},
	{Name: "cloc_stats", Description: "Count lines of code with cloc.", Command: "cloc", Args: []string{"."}, WorkDir: true},
	{Name: "scc_stats", Description: "Count lines of code with scc.", Command: "scc", WorkDir: true},
	{Name: "hyperfine_bench", Description: "Benchmark command with hyperfine.", Command: "hyperfine", Properties: map[string]map[string]interface{}{"command": {"type": "string"}}, Required: []string{"command"}},
	{Name: "asciinema_list", Description: "List asciinema recordings.", Command: "asciinema", Args: []string{"catalog"}},
	{Name: "gh_extension_list", Description: "List GitHub CLI extensions.", Command: "gh", Args: []string{"extension", "list"}},
	{Name: "gh_codespace_list", Description: "List GitHub Codespaces.", Command: "gh", Args: []string{"codespace", "list"}},
	{Name: "gh_copilot_status", Description: "GitHub Copilot status.", Command: "gh", Args: []string{"copilot", "status"}},
	{Name: "vercel_whoami", Description: "Show Vercel user.", Command: "vercel", Args: []string{"whoami"}},
	{Name: "netlify_sites", Description: "List Netlify sites.", Command: "netlify", Args: []string{"sites:list"}},
	{Name: "railway_variables", Description: "List Railway env vars.", Command: "railway", Args: []string{"variables"}, WorkDir: true},
	{Name: "fly_apps", Description: "List all Fly.io apps.", Command: "flyctl", Args: []string{"apps", "list"}},
	{Name: "render_services", Description: "List Render services.", Command: "render", Args: []string{"services", "list"}},
	{Name: "deno_bench", Description: "Run Deno benchmarks.", Command: "deno", Args: []string{"bench"}, WorkDir: true},
	{Name: "bun_test", Description: "Run Bun tests.", Command: "bun", Args: []string{"test"}, WorkDir: true},
	{Name: "bun_build", Description: "Build with Bun.", Command: "bun", Args: []string{"build"}, WorkDir: true},
	// Health checks
	{Name: "health_postgres", Description: "PostgreSQL health check.", Command: "pg_isready"},
	{Name: "health_mysql", Description: "MySQL health check.", Command: "mysqladmin", Args: []string{"ping"}},
	{Name: "health_redis_ping", Description: "Redis health check.", Command: "redis-cli", Args: []string{"ping"}},
	{Name: "health_mongo", Description: "MongoDB health check.", Command: "mongosh", Args: []string{"--eval", "db.adminCommand('ping')"}},
	{Name: "health_elasticsearch", Description: "Elasticsearch health.", Command: "curl", Args: []string{"-s", "localhost:9200/_cluster/health?pretty"}},
	{Name: "health_rabbitmq_ping", Description: "RabbitMQ health.", Command: "rabbitmqctl", Args: []string{"ping"}},
	{Name: "health_nginx", Description: "Nginx health.", Command: "curl", Args: []string{"-s", "localhost/nginx_status"}},
	{Name: "health_docker", Description: "Docker daemon health.", Command: "docker", Args: []string{"info", "--format", "{{.ServerVersion}}"}},
	{Name: "health_k8s", Description: "Kubernetes API health.", Command: "kubectl", Args: []string{"get", "--raw", "/healthz"}},
	// Dotfiles
	{Name: "dotfiles_list", Description: "List dotfiles in home.", Command: "ls", Args: []string{"-la"}},
	{Name: "zshrc_view", Description: "View .zshrc.", Command: "cat"},
	{Name: "bashrc_view", Description: "View .bashrc.", Command: "cat"},
	{Name: "gitconfig_view", Description: "View git config.", Command: "git", Args: []string{"config", "--global", "--list"}},
	{Name: "ssh_config_view", Description: "View SSH config.", Command: "cat"},
	// Disk cleanup helpers
	{Name: "ncdu_scan", Description: "Interactive disk usage (ncdu).", Command: "ncdu", Args: []string{"--color", "dark"}, WorkDir: true},
	{Name: "dust_scan", Description: "Disk usage with dust.", Command: "dust", WorkDir: true},
	{Name: "duf_usage", Description: "Disk usage with duf.", Command: "duf"},
	{Name: "btop_snapshot", Description: "System monitor snapshot.", Command: "btop", Args: []string{"--tty_on"}},
	{Name: "glances_snapshot", Description: "System monitor (glances).", Command: "glances", Args: []string{"--stdout", "cpu.total,mem.percent,net.lo.tx"}},
}

// getBulkToolDefinitions returns MCP tool definitions for all bulk tools.
func getBulkToolDefinitions() []map[string]interface{} {
	var tools []map[string]interface{}
	for _, bt := range bulkTools {
		props := map[string]interface{}{}
		if bt.WorkDir {
			props["directory"] = map[string]interface{}{"type": "string", "description": "Working directory"}
		}
		for k, v := range bt.Properties {
			props[k] = v
		}
		tool := map[string]interface{}{
			"name":        bt.Name,
			"description": bt.Description,
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": props,
			},
		}
		if len(bt.Required) > 0 {
			tool["inputSchema"].(map[string]interface{})["required"] = bt.Required
		}
		tools = append(tools, tool)
	}
	return tools
}

// handleBulkTool executes a bulk tool by name.
func handleBulkTool(name string, arguments json.RawMessage) (interface{}, bool) {
	for _, bt := range bulkTools {
		if bt.Name != name {
			continue
		}
		// Parse arguments
		var argMap map[string]interface{}
		json.Unmarshal(arguments, &argMap)

		// Build command args
		args := make([]string, len(bt.Args))
		copy(args, bt.Args)

		// Append required property values as args
		for _, req := range bt.Required {
			if v, ok := argMap[req]; ok {
				args = append(args, fmt.Sprintf("%v", v))
			}
		}

		// Execute
		cmd := osexec.Command(bt.Command, args...)
		if bt.WorkDir {
			if dir, ok := argMap["directory"].(string); ok && dir != "" {
				cmd.Dir = dir
			} else {
				wd, _ := os.Getwd()
				cmd.Dir = wd
			}
		}
		out, err := cmd.CombinedOutput()
		result := map[string]interface{}{"output": string(out)}
		if err != nil {
			result["error"] = err.Error()
		}
		return result, true
	}
	return nil, false
}
