import React, { useCallback, useRef, useState } from 'react';
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

interface FloatingButtonProps {
  /** Called when user taps the button (opens full modal by default). */
  onPress?: () => void;
  /** Initial position. Default: top-right corner. */
  initialPosition?: { x: number; y: number };
  /** Button size in pixels. Default: 48. */
  size?: number;
  /** Whether to show the inline chat panel on long-press. Default: true. */
  enableChat?: boolean;
  /** Show streaming status dot. Default: true. */
  showStreamingDot?: boolean;
}

const DEFAULT_SIZE = 48;

/**
 * Draggable floating button for the Yaver Feedback SDK.
 *
 * - **Tap** → opens the full FeedbackModal
 * - **Long-press** → expands into a mini chat panel for quick agent interaction
 * - **Drag** → reposition anywhere on screen
 *
 * The chat panel lets the user:
 * - Type messages to the agent (creates tasks)
 * - Trigger hot reload
 * - See streaming status (green dot = black box active)
 *
 * Default position: top-right corner (avoids overlap with bottom nav/tab bars).
 * User can drag it anywhere.
 */
export const FloatingButton: React.FC<FloatingButtonProps> = ({
  onPress,
  initialPosition,
  size = DEFAULT_SIZE,
  enableChat = true,
  showStreamingDot = true,
}) => {
  const { width: screenWidth } = Dimensions.get('window');
  const defaultX = initialPosition?.x ?? (screenWidth - size - 12);
  const defaultY = initialPosition?.y ?? 60; // top area, below status bar

  const pan = useRef(new Animated.ValueXY({ x: defaultX, y: defaultY })).current;
  const isDragging = useRef(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const connectionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll connection status every 5s
  React.useEffect(() => {
    const checkConnection = async () => {
      const client = YaverFeedback.getP2PClient();
      if (!client) {
        setConnectionStatus('disconnected');
        return;
      }
      try {
        const ok = await client.health();
        setConnectionStatus(ok ? 'connected' : 'disconnected');
      } catch {
        setConnectionStatus('disconnected');
      }
    };

    checkConnection();
    connectionPollRef.current = setInterval(checkConnection, 5000);
    return () => {
      if (connectionPollRef.current) clearInterval(connectionPollRef.current);
    };
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 5 || Math.abs(gs.dy) > 5,
      onPanResponderGrant: () => {
        pan.extractOffset();
        isDragging.current = false;
      },
      onPanResponderMove: (_, gs) => {
        if (Math.abs(gs.dx) > 5 || Math.abs(gs.dy) > 5) {
          isDragging.current = true;
        }
        Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false,
        })(_, gs);
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        // No-op on drag end — tap/long-press handled separately
      },
    }),
  ).current;

  const handleTap = useCallback(() => {
    if (isDragging.current) return;
    if (onPress) {
      onPress();
    } else {
      YaverFeedback.startReport();
    }
  }, [onPress]);

  const handleLongPress = useCallback(() => {
    if (!enableChat) return;
    setChatOpen((prev) => !prev);
    setLastResponse(null);
  }, [enableChat]);

  const handleSend = useCallback(async () => {
    if (!message.trim()) return;
    const config = YaverFeedback.getConfig();
    if (!config?.agentUrl) return;

    setSending(true);
    setLastResponse(null);
    Keyboard.dismiss();

    try {
      const url = config.agentUrl.replace(/\/$/, '');
      const response = await fetch(`${url}/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: message.trim(),
          source: 'feedback-chat',
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setLastResponse(`Task created: ${data.id ?? 'ok'}`);
        BlackBox.log(`Chat task: ${message.trim()}`, 'FloatingButton');
      } else {
        setLastResponse(`Error: ${response.status}`);
      }
      setMessage('');
    } catch (err) {
      setLastResponse(`Failed: ${String(err)}`);
    } finally {
      setSending(false);
    }
  }, [message]);

  const handleReconnect = useCallback(async () => {
    setConnectionStatus('connecting');
    try {
      const config = YaverFeedback.getConfig();
      if (!config) return;

      const result = await (await import('./Discovery')).YaverDiscovery.discover({
        convexUrl: config.convexUrl,
        authToken: config.authToken,
        preferredDeviceId: config.preferredDeviceId,
      });
      if (result) {
        config.agentUrl = result.url;
        // Recreate P2P client with new URL
        const { P2PClient } = await import('./P2PClient');
        const client = new P2PClient(result.url, config.authToken);
        const ok = await client.health();
        setConnectionStatus(ok ? 'connected' : 'disconnected');
        if (ok) {
          setLastResponse(`Reconnected to ${result.hostname}`);
          BlackBox.log(`Reconnected to ${result.hostname} at ${result.url}`, 'FloatingButton');
        }
      } else {
        setConnectionStatus('disconnected');
        setLastResponse('No agent found');
      }
    } catch {
      setConnectionStatus('disconnected');
      setLastResponse('Reconnect failed');
    }
  }, []);

  const handleReload = useCallback(async () => {
    const config = YaverFeedback.getConfig();
    if (!config?.agentUrl) return;

    setReloading(true);
    try {
      await fetch(`${config.agentUrl.replace(/\/$/, '')}/exec`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: 'reload', type: 'hot-reload' }),
      });
      BlackBox.lifecycle('Hot reload triggered from floating chat');
    } catch {
      // silent
    } finally {
      setReloading(false);
    }
  }, []);

  const isStreaming = BlackBox.isStreaming;

  return (
    <Animated.View
      style={[
        styles.root,
        { transform: [{ translateX: pan.x }, { translateY: pan.y }] },
      ]}
      {...panResponder.panHandlers}
    >
      {/* Chat panel (expanded) */}
      {chatOpen && (
        <View style={styles.chatPanel}>
          {/* Input row */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Ask the agent..."
              placeholderTextColor="#666"
              value={message}
              onChangeText={setMessage}
              onSubmitEditing={handleSend}
              returnKeyType="send"
              blurOnSubmit={false}
            />
            <TouchableOpacity
              style={[styles.sendBtn, sending && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={sending || !message.trim()}
            >
              {sending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.sendBtnText}>Send</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Connection status bar */}
          <View style={styles.statusBar}>
            <View style={[
              styles.statusIndicator,
              connectionStatus === 'connected' && styles.statusIndicatorConnected,
              connectionStatus === 'disconnected' && styles.statusIndicatorDisconnected,
              connectionStatus === 'connecting' && styles.statusIndicatorConnecting,
            ]} />
            <Text style={styles.statusText}>
              {connectionStatus === 'connected' ? 'Connected' :
               connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
            </Text>
            {connectionStatus === 'disconnected' && (
              <TouchableOpacity onPress={handleReconnect} style={styles.reconnectBtn}>
                <Text style={styles.reconnectBtnText}>Reconnect</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Quick actions */}
          <View style={styles.quickActions}>
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={handleReload}
              disabled={reloading || connectionStatus !== 'connected'}
            >
              <Text style={styles.quickBtnText}>
                {reloading ? 'Reloading...' : 'Hot Reload'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => {
                setChatOpen(false);
                if (onPress) onPress();
                else YaverFeedback.startReport();
              }}
            >
              <Text style={styles.quickBtnText}>Full Report</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.quickBtn,
                YaverFeedback.isEnabled() ? styles.quickBtnActive : styles.quickBtnDanger,
              ]}
              onPress={() => YaverFeedback.setEnabled(!YaverFeedback.isEnabled())}
            >
              <Text style={styles.quickBtnText}>
                {YaverFeedback.isEnabled() ? 'Disable' : 'Enable'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Response */}
          {lastResponse && (
            <Text style={styles.response}>{lastResponse}</Text>
          )}
        </View>
      )}

      {/* The button itself — color reflects connection status */}
      <TouchableOpacity
        style={[
          styles.button,
          { width: size, height: size, borderRadius: size / 2 },
          connectionStatus === 'connected' && styles.buttonConnected,
          connectionStatus === 'disconnected' && styles.buttonDisconnected,
          connectionStatus === 'connecting' && styles.buttonConnecting,
        ]}
        activeOpacity={0.8}
        onPress={handleTap}
        onLongPress={handleLongPress}
        delayLongPress={400}
      >
        <Text style={styles.label}>{chatOpen ? 'X' : 'Y'}</Text>

        {/* Streaming status dot */}
        {showStreamingDot && (
          <View
            style={[
              styles.statusDot,
              connectionStatus === 'connected' && isStreaming
                ? styles.statusDotActive
                : connectionStatus === 'connecting'
                  ? styles.statusDotConnecting
                  : styles.statusDotInactive,
            ]}
          />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    zIndex: 9999,
    alignItems: 'flex-end',
  },
  button: {
    backgroundColor: 'rgba(99, 102, 241, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
  },
  label: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  statusDot: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: 'rgba(99, 102, 241, 0.9)',
  },
  statusDotActive: {
    backgroundColor: '#22c55e',
  },
  statusDotInactive: {
    backgroundColor: '#ef4444',
  },
  statusDotConnecting: {
    backgroundColor: '#fbbf24',
  },
  // ─── Connection-aware button colors ────────────
  buttonConnected: {
    backgroundColor: 'rgba(99, 102, 241, 0.9)',  // indigo — all good
  },
  buttonDisconnected: {
    backgroundColor: 'rgba(239, 68, 68, 0.7)',   // red — disconnected
  },
  buttonConnecting: {
    backgroundColor: 'rgba(251, 191, 36, 0.7)',  // amber — connecting
  },
  // ─── Chat panel ────────────────────────────────
  chatPanel: {
    width: 280,
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#fff',
    fontSize: 13,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  sendBtn: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.5,
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  quickActions: {
    flexDirection: 'row',
    gap: 6,
  },
  quickBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  quickBtnActive: {
    borderColor: 'rgba(34, 197, 94, 0.3)',
  },
  quickBtnDanger: {
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  quickBtnText: {
    color: '#ccc',
    fontSize: 11,
    fontWeight: '500',
  },
  // ─── Connection status bar ──────────────────────
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    paddingVertical: 4,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusIndicatorConnected: {
    backgroundColor: '#22c55e',
  },
  statusIndicatorDisconnected: {
    backgroundColor: '#ef4444',
  },
  statusIndicatorConnecting: {
    backgroundColor: '#fbbf24',
  },
  statusText: {
    color: '#999',
    fontSize: 11,
    flex: 1,
  },
  reconnectBtn: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reconnectBtnText: {
    color: '#8b8bf5',
    fontSize: 10,
    fontWeight: '600',
  },
  response: {
    marginTop: 8,
    color: '#8b8bf5',
    fontSize: 11,
  },
});
