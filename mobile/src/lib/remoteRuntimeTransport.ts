export type RemoteRuntimeTransportMode = "direct-webrtc" | "relay-jpeg-poll";

// HTTP signaling may travel through Yaver's relay while WebRTC media still
// connects directly or through TURN. Coupling those two decisions forced every
// cellular user onto ~1 fps HTTP snapshots before ICE was even attempted.
export function initialRemoteRuntimeTransport(): RemoteRuntimeTransportMode {
  return "direct-webrtc";
}

export function shouldFallbackToRelayFrames(input: {
  relayAvailable: boolean;
  currentMode?: string;
  failureReason?: string;
  alreadyAttempted: boolean;
}): boolean {
  return input.relayAvailable &&
    !input.alreadyAttempted &&
    input.currentMode !== "relay-jpeg-poll" &&
    input.failureReason === "ice-failed";
}

// Agent paths arrive in native Windows spelling while RN-web and cached rows
// may use forward slashes or different drive-letter case. Only fold case for a
// Windows-shaped path; POSIX paths remain case-sensitive.
export function sameRemoteRuntimeWorkDir(a?: string | null, b?: string | null): boolean {
  const normalize = (value?: string | null): string => {
    const clean = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(clean) ? clean.toLowerCase() : clean;
  };
  const left = normalize(a);
  const right = normalize(b);
  return !!left && left === right;
}
