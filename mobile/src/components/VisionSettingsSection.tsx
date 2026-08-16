/**
 * VisionSettingsSection — configure the Yaver vision stack from the phone.
 *
 * Reads GET /vision/status and writes PUT /vision/key on the connected
 * agent (desktop/agent/mcp_vision.go). Keys are stored in
 * ~/.yaver/config.json `vision_keys` — the shared seam read by the MCP
 * vision_* tools, `yaver vision`, the QA brain and ghost vision — and are
 * NEVER rendered back to the UI.
 *
 * Free-first: on-device OCR (macOS Vision framework) works with no key at
 * all; a provider key just adds semantic verdicts (is this UI broken?).
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useColors } from "../context/ThemeContext";
import { quicClient } from "../lib/quic";

interface Props {
  connected: boolean;
}

const PROVIDERS: { id: string; label: string }[] = [
  { id: "mistral", label: "Mistral (pixtral)" },
  { id: "openai", label: "OpenAI (gpt-4o-mini)" },
  { id: "anthropic", label: "Anthropic (haiku)" },
];

function Pill({ on, c }: { on: boolean; c: ReturnType<typeof useColors> }) {
  return (
    <Text
      style={{
        fontSize: 10,
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: 0.8,
        color: on ? "#10b981" : c.textMuted,
        borderWidth: 1,
        borderColor: on ? "rgba(16,185,129,0.4)" : c.border,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        overflow: "hidden",
      }}
    >
      {on ? "ready" : "off"}
    </Text>
  );
}

export default function VisionSettingsSection({ connected }: Props) {
  const c = useColors();
  const [providersConfigured, setProvidersConfigured] = useState<string[]>([]);
  const [freeOcr, setFreeOcr] = useState(false);
  const [activeProvider, setActiveProvider] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  // Provider is OPT-IN, never a default: the section must not silently bias
  // toward Mistral (or any vendor) when the user has configured nothing.
  // Start unselected; preselect only the agent's reported active provider so
  // editing an existing config lands on the right one. Saving still requires
  // an explicit pick below.
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const st = connected ? await quicClient.getVisionStatus() : null;
    if (st) {
      setProvidersConfigured(st.providers_configured ?? []);
      setFreeOcr(!!st.free_ocr);
      setActiveProvider(st.active_provider ?? "");
      setModelOverride(st.model_override ?? "");
      // Only preselect the agent's ACTIVE provider (i.e. one a key already
      // exists for). Never auto-pick a vendor for a fresh, unconfigured box.
      setProvider(st.active_provider ?? "");
    } else {
      setProvidersConfigured([]);
      setProvider("");
    }
  }, [connected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (clear = false) => {
    if (!connected) return;
    // Saving is opt-in by vendor: with provider unselected there is nothing
    // to save to, and defaulting to Mistral would be a silent vendor bias.
    if (!clear && !provider) {
      Alert.alert("Vision", "Pick a provider first — no key is stored by default.");
      return;
    }
    setBusy(true);
    try {
      const out = await quicClient.setVisionKey(provider, key, clear);
      if (!out) {
        Alert.alert("Vision", "Failed to save the key on the connected machine.");
      } else {
        Alert.alert(
          "Vision",
          clear
            ? `Cleared ${provider} — free OCR still works without a key.`
            : out.note || `${provider} key stored — every vision surface picks it up.`,
        );
        setKey("");
        await refresh();
      }
    } catch {
      Alert.alert("Vision", "Failed to save the key on the connected machine.");
    } finally {
      setBusy(false);
    }
  };

  const configuredHere = providersConfigured.includes(provider);

  return (
    <View style={{ marginTop: 20 }}>
      <Text style={{ color: c.textPrimary, fontWeight: "700", fontSize: 15 }}>
        Vision · screenshots → text
      </Text>
      <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 }}>
        Yaver MCP gives text-only coding models (like DeepSeek V4 Flash in opencode) eyes:
        pasted screenshots, crash logs and UI failures are OCR'd on-device for free, with an
        optional semantic verdict when a vision provider is configured.
      </Text>

      <View
        style={{
          marginTop: 12,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 12,
          backgroundColor: c.bgCardElevated,
          padding: 12,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: c.textPrimary, fontWeight: "600", fontSize: 13 }}>
            Free on-device OCR
          </Text>
          <Pill on={freeOcr} c={c} />
        </View>
        <Text style={{ color: c.textMuted, fontSize: 11, lineHeight: 16 }}>
          macOS Vision framework — $0, private, works with no key.
        </Text>

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: c.textPrimary, fontWeight: "600", fontSize: 13 }}>
            Vision LLM verdict
          </Text>
          <Pill on={providersConfigured.length > 0} c={c} />
        </View>
        <Text style={{ color: c.textMuted, fontSize: 11, lineHeight: 16 }}>
          {providersConfigured.length > 0
            ? `Configured: ${providersConfigured.join(", ")}`
            : "None — free on-device OCR is on; semantic “is this UI broken?” judgments are OFF until you pick a provider and add a key."}
          {activeProvider ? ` · Active: ${activeProvider}` : ""}
          {modelOverride ? ` · Model: ${modelOverride}` : ""}
        </Text>

        <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          {PROVIDERS.map((p) => {
            const selected = provider === p.id;
            return (
              <Pressable
                key={p.id}
                onPress={() => setProvider(p.id)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: selected ? "#6366f1" : c.border,
                  backgroundColor: selected ? "rgba(99,102,241,0.12)" : "transparent",
                }}
              >
                <Text style={{ color: selected ? "#a5b4fc" : c.textPrimary, fontSize: 12 }}>
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <TextInput
          value={key}
          onChangeText={setKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={configuredHere ? "•••••••• (stored — type to replace)" : "Pick a provider above, then paste its key here"}
          placeholderTextColor={c.textMuted}
          style={{
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 8,
            backgroundColor: c.bgCard,
            color: c.textPrimary,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 13,
          }}
        />

        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => void save(false)}
            disabled={!connected || busy || !provider || key.trim() === ""}
            style={{
              flex: 1,
              borderRadius: 8,
              backgroundColor: c.textPrimary,
              paddingVertical: 10,
              alignItems: "center",
              opacity: !connected || busy || !provider || key.trim() === "" ? 0.4 : 1,
            }}
          >
            {busy ? (
              <ActivityIndicator color={c.bgCard} size="small" />
            ) : (
              <Text style={{ color: c.bgCard, fontWeight: "600", fontSize: 13 }}>
                {configuredHere ? "Replace key" : "Save key"}
              </Text>
            )}
          </Pressable>
          {configuredHere && (
            <Pressable
              onPress={() => void save(true)}
              disabled={!connected || busy}
              style={{
                borderRadius: 8,
                borderWidth: 1,
                borderColor: c.border,
                paddingVertical: 10,
                paddingHorizontal: 14,
                alignItems: "center",
                opacity: !connected || busy ? 0.4 : 1,
              }}
            >
              <Text style={{ color: c.textMuted, fontSize: 13 }}>Clear</Text>
            </Pressable>
          )}
        </View>

        <Text style={{ color: c.textMuted, fontSize: 10, lineHeight: 14 }}>
          One key enables vision everywhere: vision_analyze_image, ui_inspect, testkit_visual_check
          (PASS/WARN/FAIL for Selenium tests), `yaver vision`, the opencode paste plugin, QA and
          ghost vision. Keys stay in ~/.yaver/config.json — never synced to Convex.
        </Text>
      </View>
    </View>
  );
}
