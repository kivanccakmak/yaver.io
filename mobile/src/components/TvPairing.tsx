import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import qrcode from "qrcode-generator";
import { getConvexSiteUrl } from "../lib/auth";
import { useAuth } from "../context/AuthContext";
import { useColors } from "../context/ThemeContext";

const POLL_INTERVAL_MS = 5000;

type PairState =
  | { status: "requesting" }
  | { status: "waiting"; userCode: string; deviceCode: string; expiresAt: number }
  | { status: "error"; message: string };

function QrCode({ value, size, light, dark }: { value: string; size: number; light: string; dark: string }) {
  const qr = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    return q;
  }, [value]);

  const count = qr.getModuleCount();
  const cell = size / count;
  const rows = [];
  for (let r = 0; r < count; r++) {
    const cells = [];
    for (let c = 0; c < count; c++) {
      cells.push(
        <View
          key={c}
          style={{ width: cell, height: cell, backgroundColor: qr.isDark(r, c) ? dark : light }}
        />
      );
    }
    rows.push(<View key={r} style={{ flexDirection: "row" }}>{cells}</View>);
  }
  return (
    <View style={{ width: size, height: size, borderRadius: 16, overflow: "hidden", backgroundColor: light, marginTop: 24 }}>
      {rows}
    </View>
  );
}

/**
 * TV-friendly device-code pairing sign-in (Netflix-style QR).
 * Shows a QR + code the user scans/enters on their phone at yaver.io/auth/device,
 * then polls until authorized and signs the session in.
 */
export default function TvPairing({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const colors = useColors();
  const { login } = useAuth();
  const [pair, setPair] = useState<PairState>({ status: "requesting" });
  const [pairError, setPairError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPairing = useCallback(async () => {
    stopPolling();
    setPairError("");
    setPair({ status: "requesting" });
    try {
      const res = await fetch(`${getConvexSiteUrl()}/auth/device-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("pairing request failed");
      const data = await res.json();
      setPair({
        status: "waiting",
        userCode: data.userCode,
        deviceCode: data.deviceCode,
        expiresAt: data.expiresAt,
      });

      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(
            `${getConvexSiteUrl()}/auth/device-code/poll?device_code=${data.deviceCode}`
          );
          if (!pollRes.ok) return;
          const poll = await pollRes.json();
          if (poll.status === "authorized" && poll.token) {
            stopPolling();
            await login(poll.token);
            onDone();
          } else if (poll.status === "expired") {
            stopPolling();
            setPairError("The code expired. Start over to get a new one.");
            setPair({ status: "requesting" });
          }
        } catch {
          // Transient poll error — keep waiting
        }
      }, POLL_INTERVAL_MS);
    } catch {
      setPair({ status: "error", message: "Could not start pairing. Check your connection and try again." });
    }
  }, [login, onDone, stopPolling]);

  const minutesLeft =
    pair.status === "waiting" ? Math.max(1, Math.round((pair.expiresAt - Date.now()) / 60000)) : null;

  return (
    <View style={[styles.center, { backgroundColor: colors.bg }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Sign in on your phone</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Scan the code with your phone camera, or open
      </Text>
      <Text style={[styles.url, { color: colors.accent }]}>yaver.io/auth/device</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>and enter this code:</Text>

      {pair.status === "waiting" ? (
        <>
          <QrCode
            value={`https://yaver.io/auth/device?code=${pair.userCode}`}
            size={300}
            light={colors.bgCard}
            dark={colors.textPrimary}
          />
          <View style={[styles.codeBox, { borderColor: colors.border, backgroundColor: colors.bgCard }]}>
            <Text style={[styles.code, { color: colors.textPrimary }]}>{pair.userCode}</Text>
          </View>
          <ActivityIndicator style={{ marginTop: 20 }} color={colors.accent} />
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            Waiting for authorization… code expires in ~{minutesLeft} min
          </Text>
        </>
      ) : pair.status === "requesting" ? (
        <>
          <ActivityIndicator style={{ marginTop: 24 }} size="large" color={colors.accent} />
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Starting pairing…</Text>
        </>
      ) : null}

      {pair.status === "error" ? <Text style={[styles.error, { marginTop: 24 }]}>{pair.message}</Text> : null}
      {pairError ? <Text style={[styles.error, { marginTop: 24 }]}>{pairError}</Text> : null}

      <Pressable
        hasTVPreferredFocus={pair.status !== "waiting"}
        style={({ focused }) => [styles.button, { backgroundColor: colors.accent }, focused && styles.focused]}
        onPress={() => {
          stopPolling();
          setPairError("");
          setPair({ status: "requesting" });
          onBack?.();
        }}
      >
        <Text style={styles.buttonText}>Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 80 },
  title: { fontSize: 48, fontWeight: "800", marginBottom: 20 },
  subtitle: { fontSize: 26, marginTop: 12, textAlign: "center" },
  url: { fontSize: 32, fontWeight: "700", marginTop: 8 },
  codeBox: {
    borderWidth: 2,
    borderRadius: 16,
    marginTop: 24,
    paddingHorizontal: 48,
    paddingVertical: 24,
  },
  code: { fontSize: 72, fontWeight: "800", letterSpacing: 10 },
  error: { color: "#ff6b6b", fontSize: 18, marginBottom: 8, maxWidth: 520, textAlign: "center" },
  button: {
    borderRadius: 12,
    marginTop: 36,
    minWidth: 260,
    paddingHorizontal: 36,
    paddingVertical: 18,
    alignItems: "center",
  },
  focused: { transform: [{ scale: 1.08 }], opacity: 0.9 },
  buttonText: { color: "#fff", fontSize: 24, fontWeight: "700" },
});
