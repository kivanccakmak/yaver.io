// OpenCodeConfigModal.tsx — mobile counterpart to the web ToolsView's
// OpenCode section. Drives the same /runner/opencode/config endpoint
// on the connected device, so a phone can configure a Mac mini's
// opencode.json without SSH.
//
// Shows:
//   - Path + exists indicator + diagnostics banner (if any)
//   - Default agent + model fields (editable)
//   - Agents list (build, plan, plus any custom agent.<name> entries)
//   - Providers list with baseURL + API-key edit buttons
//   - Searchable provider/model catalog read from OpenCode on that machine
//   - On-device API-key text/QR scan; the key is sent only to the remote agent

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { quicClient, type OpenCodeConfigSummary, type OpenCodeModelSummary, type OpenCodeProviderSummary } from "../lib/quic";
import { useColors } from "../context/ThemeContext";
import { useDevice } from "../context/DeviceContext";
import ApiKeyScanner from "./ApiKeyScanner";

interface Props {
  visible: boolean;
  onClose: () => void;
  startInAddProvider?: boolean;
  /** Device to configure. Omit for the actively-connected box; pass a peer's
   *  deviceId to configure a box you're viewing but not connected to (so the
   *  provider/key/model land on the RIGHT box, not the connected one). */
  target?: string;
}

export function OpenCodeConfigModal({ visible, onClose, startInAddProvider = false, target }: Props) {
  const c = useColors();
  // All writes go to `target` (the box being configured), not the connected one.
  const saveConfig = (patch: Parameters<typeof quicClient.saveOpenCodeConfig>[0]) =>
    quicClient.saveOpenCodeConfig(patch, target);
  // Sync the device's primary runner choice to Convex once the user
  // configures a working provider+key. Without this the user has to ALSO
  // tap the runner picker in DeviceDetailsModal to flip the device's
  // primary to opencode — surfaces like the Tasks composer placeholder
  // ("Chat with Codex" vs "Chat with OpenCode") still read the old
  // userSettings.primaryRunnerByDevice value until then. The saved key
  // is the explicit "this is now my coding agent" signal — pin it.
  const { activeDevice, setPrimaryRunnerForDevice } = useDevice();
  const primaryDeviceId = target || activeDevice?.id || "";
  const [config, setConfig] = useState<OpenCodeConfigSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState("");
  const [model, setModel] = useState("");
  const [smallModel, setSmallModel] = useState("");
  const [buildModel, setBuildModel] = useState("");
  const [planModel, setPlanModel] = useState("");
  const [editingProvider, setEditingProvider] = useState<OpenCodeProviderSummary | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addId, setAddId] = useState("");
  const [addName, setAddName] = useState("");
  const [addBaseUrl, setAddBaseUrl] = useState("");
  const [addApiKey, setAddApiKey] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addModels, setAddModels] = useState<Record<string, unknown> | undefined>(undefined);
  const [presetHint, setPresetHint] = useState("");
  const [catalogProviders, setCatalogProviders] = useState<OpenCodeProviderSummary[]>([]);
  const [catalogModels, setCatalogModels] = useState<OpenCodeModelSummary[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogModelQuery, setCatalogModelQuery] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [scanTarget, setScanTarget] = useState<"add" | "edit" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await quicClient.getOpenCodeConfig(target);
      setConfig(cfg);
      if (cfg) {
        setDefaultAgent(cfg.defaultAgent || "");
        setModel(cfg.model || "");
        setSmallModel(cfg.smallModel || "");
        setBuildModel(cfg.buildModel || "");
        setPlanModel(cfg.planModel || "");
      }
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  useEffect(() => {
    if (!visible) {
      setShowAdd(false);
      setAddId("");
      setAddName("");
      setAddBaseUrl("");
      setAddApiKey("");
      setAddModel("");
      setAddModels(undefined);
      setCatalogModels([]);
      setCatalogModelQuery("");
      setPresetHint("");
      return;
    }
    if (startInAddProvider) setShowAdd(true);
  }, [visible, startInAddProvider]);

  useEffect(() => {
    if (!showAdd) return;
    let cancelled = false;
    setCatalogLoading(true);
    void quicClient.getOpenCodeCatalog(undefined, target).then((rows) => {
      if (!cancelled) setCatalogProviders(rows);
    }).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });
    return () => { cancelled = true; };
  }, [showAdd, target]);

  const chooseCatalogProvider = useCallback(async (provider: OpenCodeProviderSummary) => {
    setAddId(provider.id);
    setAddName(provider.name || provider.id);
    // Built-in OpenCode providers already own their endpoint/model metadata.
    // Writing those values into opencode.json would shadow OpenCode's catalog.
    setAddBaseUrl(provider.isBuiltin ? "" : provider.baseUrl || "");
    setAddModels(undefined);
    setCatalogModels([]);
    setCatalogModelQuery("");
    setPresetHint([
      provider.environmentKeys?.length ? `API key: ${provider.environmentKeys.join(" or ")}` : "Uses the provider's native OpenCode authentication.",
      provider.documentationUrl ? "Provider documentation is available from OpenCode." : "",
    ].filter(Boolean).join(" "));
    const detail = await quicClient.getOpenCodeCatalog(provider.id, target);
    const choices = detail[0]?.models || [];
    setCatalogModels(choices);
    const preferred = config?.model
      || config?.models?.find((row) => row.provider === provider.id && row.isDefault)?.id
      || "";
    const selected = choices.find((row) => row.id === preferred) || choices[0];
    setAddModel(selected?.id || "");
  }, [config, target]);

  const saveTopLevel = useCallback(async () => {
    setBusy(true);
    const res = await saveConfig({
      defaultAgent: defaultAgent.trim() || undefined,
      model: model.trim() || undefined,
      smallModel: smallModel.trim() || undefined,
      buildModel: buildModel.trim() || undefined,
      planModel: planModel.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      Alert.alert("Save failed", res.error || "Unknown error");
      return;
    }
    if (res.config) setConfig(res.config);
    if (primaryDeviceId) {
      // opencode model strings are "<provider>/<model>" (e.g.
      // "zai/glm-4.7"). Surface the provider half to Convex too —
      // without it, other surfaces cannot highlight the corresponding
      // provider while the selected machine's live catalog is loading.
      const m = (res.config?.model || "").trim();
      const slash = m.indexOf("/");
      const providerHint = slash > 0 ? m.slice(0, slash) : "";
      void setPrimaryRunnerForDevice(
        primaryDeviceId,
        "opencode",
        m || null,
        res.config?.defaultAgent || null,
        providerHint || null,
      ).catch(() => {});
    }
    Alert.alert("Saved", "OpenCode config updated.");
  }, [defaultAgent, model, smallModel, buildModel, planModel, primaryDeviceId, setPrimaryRunnerForDevice]);

  const saveProviderEdit = useCallback(async () => {
    if (!editingProvider) return;
    const apiKeyTrimmed = editApiKey.trim();
    setBusy(true);
    const res = await saveConfig({
      providers: [
        {
          id: editingProvider.id,
          baseUrl: editingProvider.isBuiltin ? undefined : editBaseUrl.trim() || undefined,
          apiKey: apiKeyTrimmed || undefined,
        },
      ],
    });
    setBusy(false);
    if (!res.ok) {
      Alert.alert("Save failed", res.error || "Unknown error");
      return;
    }
    if (res.config) setConfig(res.config);
    if (primaryDeviceId) {
      void setPrimaryRunnerForDevice(
        primaryDeviceId,
        "opencode",
        res.config?.model || null,
        res.config?.defaultAgent || null,
        editingProvider.id,
      ).catch(() => {});
    }
    setEditingProvider(null);
    setEditBaseUrl("");
    setEditApiKey("");
  }, [editingProvider, editBaseUrl, editApiKey, primaryDeviceId, setPrimaryRunnerForDevice]);

  const addProvider = useCallback(async () => {
    if (!addId.trim()) {
      Alert.alert("Provider id required", "Use a short id like 'glm', 'groq', or 'ollama-tailscale'.");
      return;
    }
    const providerId = addId.trim();
    const apiKeyTrimmed = addApiKey.trim();
    const rawModel = addModel.trim();
    const modelTrimmed = rawModel && !rawModel.includes("/") ? `${providerId}/${rawModel}` : rawModel;
    const selectedCatalogProvider = catalogProviders.find((provider) => provider.id === providerId);
    const customModelId = modelTrimmed.startsWith(`${providerId}/`) ? modelTrimmed.slice(providerId.length + 1) : "";
    const providerModels = addModels
      || (!selectedCatalogProvider?.isBuiltin && customModelId ? { [customModelId]: {} } : undefined);
    setBusy(true);
    const res = await saveConfig({
      defaultAgent: modelTrimmed ? "build" : undefined,
      model: modelTrimmed || undefined,
      providers: [
        {
          id: providerId,
          name: addName.trim() || undefined,
          baseUrl: addBaseUrl.trim() || undefined,
          apiKey: apiKeyTrimmed || undefined,
          models: providerModels,
        },
      ],
    });
    setBusy(false);
    if (!res.ok) {
      Alert.alert("Save failed", res.error || "Unknown error");
      return;
    }
    if (res.config) setConfig(res.config);
    if (primaryDeviceId) {
      void setPrimaryRunnerForDevice(
        primaryDeviceId,
        "opencode",
        res.config?.model || modelTrimmed || null,
        res.config?.defaultAgent || null,
        providerId,
      ).catch(() => {});
    }
    setShowAdd(false);
    setAddId("");
    setAddName("");
    setAddBaseUrl("");
    setAddApiKey("");
    setAddModel("");
    setAddModels(undefined);
    setCatalogModels([]);
    setCatalogModelQuery("");
    setPresetHint("");
  }, [addId, addName, addBaseUrl, addApiKey, addModel, addModels, catalogProviders, primaryDeviceId, setPrimaryRunnerForDevice]);

  const deleteProvider = useCallback(
    (provider: OpenCodeProviderSummary) => {
      Alert.alert(
        "Delete provider?",
        `Remove "${provider.id}" from opencode.json? This won't touch your API key vault entries.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              setBusy(true);
              const res = await saveConfig({
                providers: [{ id: provider.id, delete: true }],
              });
              setBusy(false);
              if (!res.ok) {
                Alert.alert("Delete failed", res.error || "Unknown error");
                return;
              }
              if (res.config) setConfig(res.config);
            },
          },
        ],
      );
    },
    [],
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: c.bg }]}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.headerBtn}>
            <Text style={{ color: c.accent, fontSize: 16 }}>Close</Text>
          </Pressable>
          <Text style={[styles.title, { color: c.textPrimary }]}>OpenCode Config</Text>
          <Pressable onPress={load} hitSlop={12} style={styles.headerBtn}>
            <Text style={{ color: c.accent, fontSize: 14 }}>Refresh</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {loading ? (
            <ActivityIndicator color={c.accent} style={{ marginTop: 32 }} />
          ) : !config ? (
            <Text style={[styles.muted, { color: c.textMuted }]}>
              Couldn't load opencode config — make sure a device is connected.
            </Text>
          ) : (
            <>
              <Text style={[styles.muted, { color: c.textMuted, fontFamily: "Menlo", fontSize: 11 }]}>
                Path: {config.path}
              </Text>
              <Text style={[styles.muted, { color: c.textMuted, fontSize: 11 }]}>
                {config.exists ? "✓ file exists on the device" : "(file will be created on first save)"}
              </Text>

              {/* Diagnostics — same shape as web ToolsView. */}
              {config.diagnostics && config.diagnostics.length > 0 ? (
                <View style={[styles.warnCard, { borderColor: "#f59e0b66", backgroundColor: "#f59e0b18" }]}>
                  <Text style={{ color: "#fcd34d", fontSize: 11, fontWeight: "700", marginBottom: 6 }}>
                    ⚠ Configuration issues
                  </Text>
                  {config.diagnostics.map((d, i) => (
                    <Text key={i} style={{ color: "#fde68a", fontSize: 12, marginBottom: 2 }}>• {d}</Text>
                  ))}
                </View>
              ) : null}

              <Section title="Default Agent + Models" color={c.textSecondary}>
                <Field label="Default agent" value={defaultAgent} onChange={setDefaultAgent} placeholder="build or plan" c={c} />
                <Text style={{ color: c.textMuted, fontSize: 11, marginBottom: 6 }}>Default model</Text>
                {(config.models || []).map((option) => (
                  <Pressable
                    key={option.id}
                    onPress={() => setModel(option.id)}
                    style={[styles.modelRow, { borderColor: model === option.id ? c.accent : c.border, backgroundColor: c.bgCardElevated }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.textPrimary, fontSize: 13, fontWeight: "600" }}>{option.name || option.id}</Text>
                      <Text style={{ color: c.textMuted, fontSize: 10 }}>{option.provider || option.id.split("/")[0]} · {option.id}</Text>
                    </View>
                    {model === option.id ? <Text style={{ color: c.accent, fontWeight: "700" }}>✓</Text> : null}
                  </Pressable>
                ))}
                {(config.models || []).length === 0 ? <Field label="Default model" value={model} onChange={setModel} placeholder="provider/model" c={c} /> : null}
                <Field label="Small model" value={smallModel} onChange={setSmallModel} placeholder="provider/model" c={c} />
                <Field label="Build model" value={buildModel} onChange={setBuildModel} placeholder="provider/model" c={c} />
                <Field label="Plan model" value={planModel} onChange={setPlanModel} placeholder="provider/model" c={c} />
                <Pressable
                  onPress={saveTopLevel}
                  disabled={busy}
                  style={[styles.primaryBtn, { backgroundColor: c.accent, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Save changes</Text>
                </Pressable>
              </Section>

              <Section title={`Agents (${config.agents?.length || 0})`} color={c.textSecondary}>
                {(config.agents || []).map((agent) => (
                  <View
                    key={agent.name}
                    style={[styles.row, { borderColor: c.border }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.textPrimary, fontWeight: "600" }}>
                        {agent.name}{" "}
                        {agent.isBuiltin ? <Text style={{ fontSize: 10, color: c.textMuted }}>· builtin</Text> : <Text style={{ fontSize: 10, color: "#f59e0b" }}>· custom</Text>}
                      </Text>
                      {agent.model ? (
                        <Text style={{ color: c.textMuted, fontSize: 11, fontFamily: "Menlo" }} numberOfLines={1}>{agent.model}</Text>
                      ) : (
                        <Text style={{ color: c.textMuted, fontSize: 11 }}>(inherits default model)</Text>
                      )}
                    </View>
                  </View>
                ))}
              </Section>

              <Section title={`Providers (${config.providers?.length || 0})`} color={c.textSecondary}>
                {(config.providers || []).map((provider) => (
                  <Pressable
                    key={provider.id}
                    onPress={() => {
                      setEditingProvider(provider);
                      setEditBaseUrl(provider.baseUrl || "");
                      setEditApiKey("");
                    }}
                    style={[styles.row, { borderColor: c.border }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.textPrimary, fontWeight: "600" }}>
                        {provider.name || provider.id} <Text style={{ color: c.textMuted, fontSize: 11 }}>· {provider.id}</Text>
                      </Text>
                      <Text style={{ color: c.textMuted, fontSize: 11, fontFamily: "Menlo" }} numberOfLines={1}>
                        {provider.baseUrl || "(no baseURL)"}
                      </Text>
                    </View>
                    {!provider.isBuiltin ? (
                      <Pressable hitSlop={8} onPress={() => deleteProvider(provider)}>
                        <Text style={{ color: "#ef4444", fontSize: 16 }}>×</Text>
                      </Pressable>
                    ) : null}
                  </Pressable>
                ))}
                <Pressable
                  onPress={() => setShowAdd(true)}
                  style={[styles.primaryBtn, { backgroundColor: c.accent }]}
                >
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>+ Add provider</Text>
                </Pressable>
              </Section>
            </>
          )}
        </ScrollView>

        {/* Edit-provider modal */}
        <Modal
          visible={!!editingProvider}
          animationType="slide"
          presentationStyle="formSheet"
          onRequestClose={() => setEditingProvider(null)}
        >
          <View style={[styles.container, { backgroundColor: c.bg }]}>
            <View style={[styles.header, { borderBottomColor: c.border }]}>
              <Pressable onPress={() => setEditingProvider(null)} hitSlop={12} style={styles.headerBtn}>
                <Text style={{ color: c.accent, fontSize: 16 }}>Cancel</Text>
              </Pressable>
              <Text style={[styles.title, { color: c.textPrimary }]}>{editingProvider?.id}</Text>
              <View style={styles.headerBtn} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              {!editingProvider?.isBuiltin ? (
                <Field label="Base URL" value={editBaseUrl} onChange={setEditBaseUrl} placeholder="https://… or http://127.0.0.1:11434/v1" c={c} />
              ) : (
                <Text style={[styles.muted, { color: c.textMuted, marginBottom: 10 }]}>OpenCode owns this provider’s endpoint and model catalog.</Text>
              )}
              <Field label="API key" value={editApiKey} onChange={setEditApiKey} placeholder="(leave empty to keep existing)" c={c} secret />
              <Pressable onPress={() => setScanTarget("edit")} style={[styles.scanBtn, { borderColor: c.border }]}>
                <Text style={{ color: c.accent, fontWeight: "700" }}>▣ Scan API key</Text>
              </Pressable>
              <Pressable
                onPress={saveProviderEdit}
                disabled={busy}
                style={[styles.primaryBtn, { backgroundColor: c.accent, opacity: busy ? 0.5 : 1 }]}
              >
                <Text style={{ color: "#fff", fontWeight: "700" }}>Save provider</Text>
              </Pressable>
            </ScrollView>
          </View>
        </Modal>

        {/* Add-provider modal with presets */}
        <Modal
          visible={showAdd}
          animationType="slide"
          presentationStyle="formSheet"
          onRequestClose={() => setShowAdd(false)}
        >
          <View style={[styles.container, { backgroundColor: c.bg }]}>
            <View style={[styles.header, { borderBottomColor: c.border }]}>
              <Pressable onPress={() => setShowAdd(false)} hitSlop={12} style={styles.headerBtn}>
                <Text style={{ color: c.accent, fontSize: 16 }}>Cancel</Text>
              </Pressable>
              <Text style={[styles.title, { color: c.textPrimary }]}>
                {startInAddProvider ? "Set up OpenCode" : "Add provider"}
              </Text>
              <View style={styles.headerBtn} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              <Text style={[styles.muted, { color: c.textMuted, marginBottom: 8 }]}>
                {startInAddProvider
                  ? "Pick where OpenCode should route requests on this machine."
                  : "Choose any provider exposed by this machine's OpenCode install."}
              </Text>
              <TextInput
                value={catalogQuery}
                onChangeText={setCatalogQuery}
                placeholder="Search providers"
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.search, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.bgCardElevated }]}
              />
              {catalogLoading ? <ActivityIndicator color={c.accent} style={{ marginVertical: 12 }} /> : null}
              <View style={{ gap: 6, marginBottom: 12 }}>
                {catalogProviders
                  .filter((p) => !catalogQuery.trim() || `${p.name || ""} ${p.id}`.toLowerCase().includes(catalogQuery.trim().toLowerCase()))
                  .slice(0, 40)
                  .map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => void chooseCatalogProvider(p)}
                    style={({ pressed }) => [
                      { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: addId === p.id ? c.accent : c.border, backgroundColor: c.bgCardElevated },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text style={{ color: c.textPrimary, fontSize: 13, fontWeight: "600" }}>{p.name || p.id}</Text>
                    <Text style={{ color: c.textMuted, fontSize: 11 }}>{p.id}{p.environmentKeys?.[0] ? ` · ${p.environmentKeys[0]}` : ""}</Text>
                  </Pressable>
                ))}
              </View>
              {presetHint ? <Text style={[styles.muted, { color: c.textMuted, fontSize: 11, marginBottom: 8 }]}>{presetHint}</Text> : null}
              <Field label="Provider id" value={addId} onChange={setAddId} placeholder="glm / groq / ollama-tailscale" c={c} />
              {!catalogProviders.find((provider) => provider.id === addId)?.isBuiltin ? (
                <Field label="Base URL" value={addBaseUrl} onChange={setAddBaseUrl} placeholder="https://… or http://127.0.0.1:11434/v1" c={c} />
              ) : null}
              {catalogModels.length > 0 ? (
                <View style={{ marginBottom: 10 }}>
                  <Text style={{ color: c.textMuted, fontSize: 11, marginBottom: 4 }}>Default model</Text>
                  <TextInput
                    value={catalogModelQuery}
                    onChangeText={setCatalogModelQuery}
                    placeholder="Search models"
                    placeholderTextColor={c.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.search, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.bgCardElevated }]}
                  />
                  <View style={{ gap: 6, marginTop: 7 }}>
                    {catalogModels
                      .filter((row) => !catalogModelQuery.trim() || `${row.name || ""} ${row.id}`.toLowerCase().includes(catalogModelQuery.trim().toLowerCase()))
                      .slice(0, 50)
                      .map((row) => {
                        const selected = addModel === row.id;
                        return (
                          <Pressable
                            key={row.id}
                            onPress={() => setAddModel(row.id)}
                            style={[styles.modelRow, { borderColor: selected ? c.accent : c.border, backgroundColor: c.bgCardElevated }]}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: c.textPrimary, fontSize: 13, fontWeight: "600" }}>{row.name || row.id}</Text>
                              <Text style={{ color: c.textMuted, fontSize: 10 }} numberOfLines={1}>{row.id}</Text>
                            </View>
                            {selected ? <Text style={{ color: c.accent, fontWeight: "700" }}>✓</Text> : null}
                          </Pressable>
                        );
                      })}
                  </View>
                </View>
              ) : (
                <Field label="Default model" value={addModel} onChange={setAddModel} placeholder="provider/model (optional)" c={c} />
              )}
              <Field label="API key" value={addApiKey} onChange={setAddApiKey} placeholder="(leave empty for local Ollama)" c={c} secret />
              <Pressable onPress={() => setScanTarget("add")} style={[styles.scanBtn, { borderColor: c.border }]}>
                <Text style={{ color: c.accent, fontWeight: "700" }}>▣ Scan API key</Text>
              </Pressable>
              <Pressable
                onPress={addProvider}
                disabled={busy || !addId.trim()}
                style={[styles.primaryBtn, { backgroundColor: c.accent, opacity: busy || !addId.trim() ? 0.5 : 1 }]}
              >
                <Text style={{ color: "#fff", fontWeight: "700" }}>Save provider</Text>
              </Pressable>
            </ScrollView>
          </View>
        </Modal>
        <Modal visible={scanTarget !== null} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScanTarget(null)}>
          <ApiKeyScanner
            provider={scanTarget === "edit" ? editingProvider?.id : addId}
            onClose={() => setScanTarget(null)}
            onScanned={({ apiKey }) => {
              if (scanTarget === "edit") setEditApiKey(apiKey);
              else setAddApiKey(apiKey);
              setScanTarget(null);
            }}
          />
        </Modal>
      </View>
    </Modal>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 24 }}>
      <Text style={{ color, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  c,
  secret,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  c: ReturnType<typeof useColors>;
  secret?: boolean;
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ color: c.textMuted, fontSize: 11, marginBottom: 4 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        secureTextEntry={!!secret}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: c.textPrimary,
          fontSize: 13,
          fontFamily: "Menlo",
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.bgCardElevated,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  headerBtn: { minWidth: 56, alignItems: "center" },
  title: { fontSize: 16, fontWeight: "700", flex: 1, textAlign: "center" },
  muted: { fontSize: 12 },
  warnCard: { marginTop: 12, padding: 10, borderRadius: 6, borderWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, marginBottom: 8 },
  modelRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 11, borderRadius: 10, borderWidth: 1, marginBottom: 6 },
  search: { paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12, borderWidth: 1, marginBottom: 10 },
  scanBtn: { alignItems: "center", paddingVertical: 11, borderRadius: 10, borderWidth: 1, marginTop: -2, marginBottom: 4 },
  primaryBtn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 6, alignItems: "center", marginTop: 12 },
});
