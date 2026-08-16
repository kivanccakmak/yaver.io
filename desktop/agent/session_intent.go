package main

// session_intent.go — natural-language session commands from ANY surface,
// EN + TR. A car driver says "start a new session" and means create a runner
// seat, not "type this sentence as a coding prompt". A watch says "hangi
// oturumlar açık?" and means list, not submit the sentence to Claude. This
// file turns those utterances into structured lifecycle intents BEFORE the
// text reaches a session as a prompt.
//
// It lives at the turn boundary on purpose: the same classifier feeds
//
//   - /runner/session/turn (watch / car / TV / voice)
//   - the runner_turn ops verb (MCP)
//
// so a phrase is caught identically whether it arrives over HTTP or MCP, and
// the tmux hazard guards (never type into a menu, never type into a shell)
// still apply to everything that is NOT an intent.
//
// Detection is deliberately cheap and local — substring phrase tables, not an
// LLM. A false NEGATIVE is harmless (the sentence just goes to the runner as a
// prompt); a false POSITIVE is prevented by requiring a strong stem plus a
// lifecycle verb (see matchSessionIntent). If the phrase is ambiguous, the
// intent returns NeedsChoice=true and the caller asks back.

import (
	"strings"
	"unicode"
)

// SessionIntentAction is the lifecycle action a natural-language phrase maps to.
type SessionIntentAction string

const (
	SessionIntentStart   SessionIntentAction = "start"    // start a new runner session
	SessionIntentList    SessionIntentAction = "list"     // what's running right now
	SessionIntentClose   SessionIntentAction = "close"    // close/stop one or all sessions
	SessionIntentSwitch  SessionIntentAction = "switch"   // drive a specific named/typed session
	SessionIntentStopAll SessionIntentAction = "stop_all" // close every runner session
)

// SessionIntent is the parsed result of a natural-language session command.
type SessionIntent struct {
	Action SessionIntentAction `json:"action"`
	// Runner is a runner id the phrase named (claude/codex/opencode) when one
	// was mentioned ("start a codex session"). Empty = caller's default.
	Runner string `json:"runner,omitempty"`
	// SessionName is a session name the phrase named ("switch to yaver-codex").
	SessionName string `json:"sessionName,omitempty"`
	// NeedsChoice is true when the phrase is a lifecycle intent but the target
	// is ambiguous (e.g. "close the session" with several live). The caller
	// must resolve against the live session list before acting.
	NeedsChoice bool `json:"needsChoice,omitempty"`
	// Reason is the human sentence explaining what was recognised, in the
	// phrase's own language where cheap. Used for the spoken reply.
	Reason string `json:"reason,omitempty"`
}

// sessionIntentPhrase is one lifecycle phrase in one language.
type sessionIntentPhrase struct {
	action SessionIntentAction
	lang   string // "en" | "tr"
}

// sessionIntentPhrases are the phrase tables. Stems are matched case- and
// fold-insensitively via strings.ToLower (handles Turkish dotted-i).
var sessionIntentPhrases = []sessionIntentPhrase{
	// ── start a new session ────────────────────────────────────────────
	{SessionIntentStart, "en"}, // "start a new session"
	{SessionIntentStart, "tr"}, // "yeni bir oturum başlat"

	// ── list sessions ──────────────────────────────────────────────────
	{SessionIntentList, "en"}, // "which sessions are running"
	{SessionIntentList, "tr"}, // "hangi oturumlar açık"

	// ── close one / stop all ───────────────────────────────────────────
	{SessionIntentClose, "en"},   // "close the session"
	{SessionIntentStopAll, "en"}, // "close all sessions"
	{SessionIntentStopAll, "tr"}, // "tüm oturumları kapat"

	// ── switch to a named session ──────────────────────────────────────
	{SessionIntentSwitch, "en"}, // "switch to the codex session"
	{SessionIntentSwitch, "tr"}, // "codex oturumuna geç"
}

// sessionIntentPhrases are the phrase tables. Matching requires BOTH a
// session noun AND an action-specific verb family (see
// sessionIntentVerbTokensForAction) — never a bare "start"/"close" without a
// session noun, so "start the build" still reaches the runner as a prompt.

var sessionIntentNounTokens = []string{
	// English nouns
	"session", "sessions", "oturum", "oturumları", "oturumlar", // tr
}

var sessionIntentRunnerTokens = map[string]string{
	"claude": "claude", "codex": "codex", "opencode": "opencode",
	"aider": "aider",
}

// foldEqual reports whether two strings are equal ignoring case and Unicode
// simple folds. Unicode ToLower handles Turkish dotted/dotless-i for the
// phrase tables here ("OTURUMLAR" → "oturumlar", "BAŞLAT" → "başlat").
func foldEqual(a, b string) bool {
	return strings.ToLower(a) == strings.ToLower(b)
}

// matchSessionIntent attempts to classify a spoken/typed utterance as a
// session-lifecycle intent. Returns nil when the text is (or could be) a
// coding prompt — callers then send it to the session unchanged.
func matchSessionIntent(text string) *SessionIntent {
	clean := strings.ToLower(strings.TrimSpace(text))
	if clean == "" {
		return nil
	}
	words := strings.FieldsFunc(clean, func(r rune) bool {
		return unicode.IsSpace(r) || r == ',' || r == '.' || r == '?' || r == '!' || r == ':'
	})
	if len(words) == 0 {
		return nil
	}

	// A lifecycle phrase must name a session noun and a lifecycle verb.
	hasNoun := false
	var verb *sessionIntentPhrase
	for _, w := range words {
		if sessionIntentPhraseMatchesNoun(w) {
			hasNoun = true
		}
	}
	if !hasNoun {
		return nil
	}
	verb = sessionIntentPhraseForWords(words)
	if verb == nil {
		return nil
	}

	// Which runner/session was named, if any.
	runner := ""
	sessionName := ""
	for _, w := range words {
		if id, ok := sessionIntentRunnerTokens[w]; ok {
			runner = id
		}
		if strings.HasPrefix(w, "yaver-") {
			sessionName = w
		}
	}

	intent := &SessionIntent{
		Action:      verb.action,
		Runner:      runner,
		SessionName: sessionName,
		Reason:      sessionIntentReason(verb, clean, runner),
	}

	// "switch to X" needs a target; without one it's a list-or-ask.
	if intent.Action == SessionIntentSwitch && sessionName == "" && runner == "" {
		intent.NeedsChoice = true
		intent.Reason = "Which session? Name one, like 'codex' or 'yaver-codex'."
		return intent
	}
	// "close the session" with no name: ask which one. "Close all sessions"
	// is already explicit and must not be mislabeled as ambiguous.
	if intent.Action == SessionIntentClose && sessionName == "" && runner == "" {
		intent.NeedsChoice = true
		intent.Reason = "Which session? Say the name, or 'all' to close everything."
		return intent
	}
	return intent
}

// sessionIntentPhraseMatchesNoun reports whether a token is a session noun.
func sessionIntentPhraseMatchesNoun(w string) bool {
	for _, n := range sessionIntentNounTokens {
		if foldEqual(w, n) {
			return true
		}
	}
	// A named session like "yaver-codex" IS a session noun.
	if strings.HasPrefix(w, "yaver-") {
		return true
	}
	// Turkish plural/possessive inflections that fold-equal won't catch
	// ("oturumları", "oturumlar"): strip a couple of common suffixes.
	for _, stem := range []string{"oturum"} {
		if strings.HasPrefix(w, stem) {
			return true
		}
	}
	return false
}

// sessionIntentPhraseForWords finds the FIRST lifecycle phrase whose verb
// tokens appear in the utterance, in an order that prefers the more specific
// action (stop_all over close, switch over start).
func sessionIntentPhraseForWords(words []string) *sessionIntentPhrase {
	// Prefer the most specific actions first.
	priority := []SessionIntentAction{
		SessionIntentStopAll, SessionIntentSwitch,
		SessionIntentClose, SessionIntentStart, SessionIntentList,
	}
	for _, action := range priority {
		for i := range sessionIntentPhrases {
			p := &sessionIntentPhrases[i]
			if p.action != action {
				continue
			}
			if phraseMatchesWords(p, words) {
				return p
			}
		}
	}
	return nil
}

func phraseMatchesWords(p *sessionIntentPhrase, words []string) bool {
	switch p.action {
	case SessionIntentStopAll:
		// needs "close"/"stop" + "all" + a session noun.
		hasAll := false
		hasVerb := false
		for _, w := range words {
			if foldEqual(w, "all") || foldEqual(w, "tüm") || foldEqual(w, "hepsi") {
				hasAll = true
			}
			if sessionIntentVerbTokenFor(p, w) {
				hasVerb = true
			}
		}
		return hasAll && hasVerb
	case SessionIntentSwitch:
		// "switch to X" — needs a switch verb + (a session noun or a runner).
		hasVerb := false
		for _, w := range words {
			if sessionIntentVerbTokenFor(p, w) {
				hasVerb = true
			}
		}
		return hasVerb
	case SessionIntentList:
		// "which sessions are open" — list verb + session noun (already checked).
		for _, w := range words {
			if sessionIntentVerbTokenFor(p, w) {
				return true
			}
		}
		return false
	default: // start / close
		for _, w := range words {
			if sessionIntentVerbTokenFor(p, w) {
				return true
			}
		}
		return false
	}
}

// sessionIntentVerbTokensForAction returns the verb tokens that signal each
// lifecycle action. Matching is per-action so "start a new session" can never
// read as "switch" (the switch family is a different word set entirely).
func sessionIntentVerbTokensForAction(action SessionIntentAction) []string {
	switch action {
	case SessionIntentStart:
		return []string{"start", "create", "launch", "new", "başlat", "başlama", "kur"}
	case SessionIntentList:
		return []string{"list", "show", "what", "which", "running", "göster", "listele", "açık"}
	case SessionIntentClose, SessionIntentStopAll:
		return []string{"close", "stop", "end", "kill", "kapat", "durdur", "kapatma", "durdurma"}
	case SessionIntentSwitch:
		return []string{"switch", "change", "move", "use", "geç", "değiştir", "kullan"}
	}
	return nil
}

// sessionIntentVerbTokenFor reports whether a word is a verb token for the
// given action's language/action family.
func sessionIntentVerbTokenFor(p *sessionIntentPhrase, w string) bool {
	for _, v := range sessionIntentVerbTokensForAction(p.action) {
		if foldEqual(w, v) {
			return true
		}
	}
	return false
}

func sessionIntentReason(p *sessionIntentPhrase, phrase, runner string) string {
	switch p.action {
	case SessionIntentStart:
		if runner != "" {
			return "Starting a new " + runner + " session."
		}
		return "Starting a new session."
	case SessionIntentList:
		return "Listing the running sessions."
	case SessionIntentStopAll:
		return "Closing all runner sessions."
	case SessionIntentClose:
		return "Closing the session."
	case SessionIntentSwitch:
		if runner != "" {
			return "Switching to the " + runner + " session."
		}
		return "Switching sessions."
	}
	return ""
}

// detectSessionIntent is the single entry point the turn path calls. It
// returns (intent, false) when the text is not a lifecycle command.
func detectSessionIntent(text string) (*SessionIntent, bool) {
	// Lifecycle interception is deliberately conservative: swallowing a coding
	// prompt is destructive because the requested work never reaches the
	// runner. These tokens make the utterance clearly ABOUT implementation,
	// rather than a command to the session manager. Examples such as "show me
	// the session handling code" and "start the session tests" must pass
	// through unchanged.
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && r != '-'
	})
	for _, w := range words {
		switch w {
		case "code", "implementation", "implement", "handling", "logic", "bug", "test", "tests", "file", "function",
			"kod", "uygulama", "uygula", "hata", "testi", "testler", "dosya", "fonksiyon":
			return nil, false
		}
	}
	intent := matchSessionIntent(text)
	if intent == nil {
		return nil, false
	}
	return intent, true
}
