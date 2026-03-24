import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Keyboard,
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { YaverFeedback } from './YaverFeedback';
import { BlackBox } from './BlackBox';

export interface FloatingButtonProps {
  /** Called when user taps the button (opens inline console by default). */
  onPress?: () => void;
  /** Initial position. Default: top-right corner, below status bar. */
  initialPosition?: { x: number; y: number };
  /** Button size in pixels. Default: 40. */
  size?: number;
  /**
   * Button background color. Default: "#ec4899" (hot pink).
   * Use a distinctive color so the debug button is never confused
   * with your app's UI. Suggested: pink, purple, lime.
   */
  color?: string;
  /** Show connection status dot on the button. Default: true. */
  showStatusDot?: boolean;
  /**
   * Style preset:
   * - "terminal" (default) — dark terminal look with >_ icon, monospace font, pink accents
   * - "minimal" — small circle, single-letter icon, clean panel
   */
  style?: 'terminal' | 'minimal';
  /** Custom icon text. Default: "Y". */
  icon?: string;
  /** Agent base URL (auto-detected from YaverFeedback config if omitted). */
  agentUrl?: string;
  /** Auth token (auto-detected from YaverFeedback config if omitted). */
  authToken?: string;
  /**
   * Health check interval in ms. The button polls the agent's /health
   * endpoint to show connection status. Default: 5000. Set to 0 to disable.
   */
  healthCheckInterval?: number;
}

const DEFAULT_SIZE = 40;
const DEFAULT_COLOR = '#6366f1';

/**
 * Draggable debug console button for the Yaver Feedback SDK.
 *
 * Drop this into any React Native app for an instant debug console:
 *
 * ```tsx
 * import { FloatingButton } from '@yaver/feedback-react-native';
 *
 * function App() {
 *   return (
 *     <>
 *       <YourApp />
 *       <FloatingButton />
 *     </>
 *   );
 * }
 * ```
 *
 * - **Tap** → expand terminal-style console panel
 * - **Drag** → reposition anywhere
 * - **Type** → send tasks to the AI agent
 * - **"reload"** → trigger hot reload
 * - **"quit"** → disable the SDK
 *
 * The button is hot pink by default — unmistakable debug tool,
 * never confused with app UI. Customize with `color` prop.
 */
export const FloatingButton: React.FC<FloatingButtonProps> = ({
  onPress,
  initialPosition,
  size = DEFAULT_SIZE,
  color = DEFAULT_COLOR,
  showStatusDot = true,
  style: stylePreset = 'terminal',
  icon,
  agentUrl: agentUrlProp,
  authToken: authTokenProp,
  healthCheckInterval = 5000,
}) => {
  const { width: screenWidth } = Dimensions.get('window');
  const defaultX = initialPosition?.x ?? (screenWidth - size - 10);
  const defaultY = initialPosition?.y ?? 90;

  const pan = useRef(new Animated.ValueXY({ x: defaultX, y: defaultY })).current;
  const isDragging = useRef(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  // Resolve agent URL and token
  const config = YaverFeedback.getConfig();
  const agentUrl = agentUrlProp || config?.agentUrl;
  const authToken = authTokenProp || config?.authToken;

  // Connection health polling
  useEffect(() => {
    if (!healthCheckInterval || !agentUrl) return;

    const check = async () => {
      try {
        const client = YaverFeedback.getP2PClient();
        if (client) {
          setIsConnected(await client.health());
        } else if (agentUrl) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const resp = await fetch(`${agentUrl.replace(/\/$/, '')}/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);
          setIsConnected(resp.ok);
        }
      } catch {
        setIsConnected(false);
      }
    };

    check();
    const interval = setInterval(check, healthCheckInterval);
    return () => clearInterval(interval);
  }, [agentUrl, healthCheckInterval]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 4 || Math.abs(gs.dy) > 4,
      onPanResponderGrant: () => {
        pan.extractOffset();
        isDragging.current = false;
      },
      onPanResponderMove: (_, gs) => {
        if (Math.abs(gs.dx) > 4 || Math.abs(gs.dy) > 4) isDragging.current = true;
        Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false })(_, gs);
      },
      onPanResponderRelease: () => pan.flattenOffset(),
    }),
  ).current;

  const handleTap = useCallback(() => {
    if (isDragging.current) return;
    if (onPress) {
      onPress();
    } else {
      setChatOpen((prev) => !prev);
      setLastResponse(null);
    }
  }, [onPress]);

  const handleSend = useCallback(async () => {
    if (!message.trim() || !agentUrl || !authToken) return;
    setSending(true);
    setLastResponse(null);
    Keyboard.dismiss();
    try {
      const url = agentUrl.replace(/\/$/, '');
      const resp = await fetch(`${url}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: message.trim(), source: 'feedback-console' }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setLastResponse(`> task ${data.id ?? 'ok'}`);
        BlackBox.log(`Console task: ${message.trim()}`, 'FloatingButton');
      } else {
        setLastResponse(`> err ${resp.status}`);
      }
      setMessage('');
    } catch (e) {
      setLastResponse(`> fail: ${String(e).slice(0, 40)}`);
    } finally {
      setSending(false);
    }
  }, [message, agentUrl, authToken]);

  const handleReload = useCallback(async () => {
    if (!agentUrl || !authToken) return;
    setReloading(true);
    try {
      await fetch(`${agentUrl.replace(/\/$/, '')}/exec`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'reload', type: 'hot-reload' }),
      });
      setLastResponse('> reload ok');
      BlackBox.lifecycle('Hot reload triggered from debug console');
    } catch {
      setLastResponse('> reload fail');
    } finally {
      setReloading(false);
    }
  }, [agentUrl, authToken]);

  const handleDisable = useCallback(() => {
    YaverFeedback.setEnabled(false);
    setChatOpen(false);
  }, []);

  const isTerminal = stylePreset === 'terminal';
  const buttonIcon = icon ?? 'y';
  const btnBg = isConnected ? color : `${color}88`;

  return (
    <Animated.View
      style={[s.root, { transform: [{ translateX: pan.x }, { translateY: pan.y }] }]}
      {...panResponder.panHandlers}
    >
      {/* Console panel */}
      {chatOpen && (
        <View style={[s.panel, isTerminal ? s.panelTerminal : s.panelMinimal, { borderColor: `${color}44` }]}>
          {/* Header */}
          <View style={s.headerRow}>
            <Text style={[s.headerTitle, isTerminal && s.mono, { color }]}>
              {isTerminal ? 'YAVER DEBUG' : 'Yaver'}
            </Text>
            <View style={[s.dotSmall, isConnected ? s.green : s.red]} />
            <Text style={[s.headerStatus, isTerminal && s.mono]}>
              {isConnected ? 'live' : 'off'}
            </Text>
            <TouchableOpacity onPress={() => setChatOpen(false)} style={s.xBtn}>
              <Text style={s.xBtnText}>{'\u2715'}</Text>
            </TouchableOpacity>
          </View>

          {/* Input */}
          <View style={s.inputRow}>
            {isTerminal && <Text style={[s.prompt, { color }]}>&gt;</Text>}
            <TextInput
              style={[s.input, isTerminal && s.mono]}
              placeholder={isTerminal ? 'tell the agent...' : 'Type a message...'}
              placeholderTextColor="#444"
              value={message}
              onChangeText={setMessage}
              onSubmitEditing={handleSend}
              returnKeyType="send"
            />
            <TouchableOpacity
              style={[s.goBtn, { backgroundColor: color }, (sending || !message.trim()) && s.dim]}
              onPress={handleSend}
              disabled={sending || !message.trim() || !isConnected}
            >
              {sending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={[s.goBtnText, isTerminal && s.mono]}>
                  {isTerminal ? 'run' : 'Send'}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Quick actions */}
          <View style={s.actionsRow}>
            <TouchableOpacity
              style={[s.actionBtn, !isConnected && s.dim]}
              onPress={handleReload}
              disabled={reloading || !isConnected}
            >
              <Text style={[s.actionText, isTerminal && s.mono]}>
                {reloading ? '...' : 'reload'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.actionBtn}
              onPress={() => {
                setChatOpen(false);
                YaverFeedback.startReport();
              }}
            >
              <Text style={[s.actionText, isTerminal && s.mono]}>report</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.actionBtn} onPress={handleDisable}>
              <Text style={[s.actionText, isTerminal && s.mono, { color: '#f87171' }]}>quit</Text>
            </TouchableOpacity>
          </View>

          {/* Output */}
          {lastResponse && (
            <Text style={[s.output, isTerminal && s.mono]}>{lastResponse}</Text>
          )}
        </View>
      )}

      {/* The button */}
      <TouchableOpacity
        style={[
          s.button,
          isTerminal ? s.buttonTerminal : s.buttonMinimal,
          { backgroundColor: btnBg, width: size, height: size },
          !isTerminal && { borderRadius: size / 2 },
        ]}
        activeOpacity={0.7}
        onPress={handleTap}
      >
        <Text style={[s.buttonIcon, isTerminal && s.mono, { fontSize: 22 }]}>
          {chatOpen ? '\u2715' : buttonIcon}
        </Text>
        {showStatusDot && (
          <View style={[s.statusDot, isConnected ? s.green : s.red]} />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};

const s = StyleSheet.create({
  root: { position: 'absolute', zIndex: 99999, alignItems: 'flex-end' },
  mono: { fontFamily: 'Courier' },
  // Button variants
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.5,
    shadowRadius: 5,
    elevation: 10,
  },
  buttonTerminal: { borderRadius: 10 },
  buttonMinimal: { /* borderRadius set inline */ },
  buttonIcon: { color: '#fff', fontWeight: '800', fontStyle: 'italic' as const },
  statusDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#000',
  },
  green: { backgroundColor: '#22c55e' },
  red: { backgroundColor: '#ef4444' },
  // Panel variants
  panel: {
    width: 260,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 12,
  },
  panelTerminal: {
    backgroundColor: '#0a0a0a',
    borderRadius: 12,
  },
  panelMinimal: {
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
  },
  // Header
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 5 },
  headerTitle: { flex: 1, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  dotSmall: { width: 6, height: 6, borderRadius: 3 },
  headerStatus: { fontSize: 10, color: '#666' },
  xBtn: { paddingHorizontal: 6, paddingVertical: 2 },
  xBtnText: { color: '#666', fontSize: 12 },
  // Input
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  prompt: { fontSize: 14, fontWeight: '700' },
  input: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: '#e5e5e5',
    fontSize: 12,
    borderWidth: 1,
    borderColor: '#222',
  },
  goBtn: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  goBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  dim: { opacity: 0.3 },
  // Actions
  actionsRow: { flexDirection: 'row', gap: 4 },
  actionBtn: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#1a1a1a',
  },
  actionText: { fontSize: 10, color: '#888', fontWeight: '600' },
  // Output
  output: { marginTop: 6, fontSize: 11, color: '#22c55e' },
});
