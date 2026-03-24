import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { YaverDiscovery, DiscoveryResult } from './Discovery';
import { YaverFeedback } from './YaverFeedback';

/**
 * Full-screen connection UI for discovering and connecting to a Yaver agent.
 *
 * Shows connection status, auto-discovery, manual URL entry, and a
 * Start/Stop testing toggle with recording timer.
 *
 * Usage:
 * ```tsx
 * {__DEV__ && <YaverConnectionScreen />}
 * ```
 */
export const YaverConnectionScreen: React.FC = () => {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [hostname, setHostname] = useState('');
  const [version, setVersion] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-discover on mount
  useEffect(() => {
    handleDiscover();
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  // Recording timer
  useEffect(() => {
    if (recording) {
      setRecordingTime(0);
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setRecordingTime(0);
    }
  }, [recording]);

  const applyResult = (result: DiscoveryResult) => {
    setUrl(result.url);
    setHostname(result.hostname);
    setVersion(result.version);
    setLatency(result.latency);
    setConnected(true);
    setError(null);

    // Update YaverFeedback config if initialized
    const config = YaverFeedback.getConfig();
    if (config) {
      YaverFeedback.init({ ...config, agentUrl: result.url });
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setError(null);

    try {
      const result = await YaverDiscovery.discover();
      if (result) {
        applyResult(result);
      } else {
        setConnected(false);
        setError('No agent found on the local network.');
      }
    } catch (err) {
      setConnected(false);
      setError(`Discovery failed: ${String(err)}`);
    } finally {
      setDiscovering(false);
    }
  };

  const handleConnect = async () => {
    if (!url.trim()) {
      setError('Enter an agent URL.');
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      const result = await YaverDiscovery.connect(url.trim());
      if (result) {
        applyResult(result);
      } else {
        setConnected(false);
        setError('Could not connect to agent at that URL.');
      }
    } catch (err) {
      setConnected(false);
      setError(`Connection failed: ${String(err)}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleToggleRecording = () => {
    if (!connected) {
      setError('Connect to an agent first.');
      return;
    }

    if (recording) {
      // Stop & send
      setRecording(false);
      YaverFeedback.startReport();
    } else {
      // Start testing
      setRecording(true);

      // Initialize SDK with current URL/token if not already done
      if (!YaverFeedback.isInitialized()) {
        YaverFeedback.init({
          agentUrl: url,
          authToken: token,
          trigger: 'manual',
        });
      }
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <Text style={styles.title}>Yaver Agent</Text>

        {/* Connection status */}
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, connected ? styles.statusConnected : styles.statusDisconnected]} />
          <Text style={styles.statusText}>
            {connected
              ? `Connected to ${hostname}`
              : 'Not connected'}
          </Text>
        </View>

        {connected && (
          <View style={styles.infoRow}>
            <Text style={styles.infoText}>v{version}</Text>
            {latency !== null && (
              <Text style={styles.infoText}>{latency}ms</Text>
            )}
          </View>
        )}

        {/* URL input */}
        <Text style={styles.label}>Agent URL</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="http://192.168.1.10:18080"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        {/* Token input */}
        <Text style={styles.label}>Auth Token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="your-auth-token"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        {/* Action buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.discoverButton]}
            onPress={handleDiscover}
            disabled={discovering}
          >
            {discovering ? (
              <ActivityIndicator color="#e0e0e0" size="small" />
            ) : (
              <Text style={styles.buttonText}>Auto-discover</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, styles.connectButton]}
            onPress={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.buttonText}>Connect</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Error */}
        {error && <Text style={styles.error}>{error}</Text>}

        {/* Recording indicator */}
        {recording && (
          <View style={styles.recordingIndicator}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>
              Recording {formatTime(recordingTime)}
            </Text>
          </View>
        )}

        {/* Start/Stop toggle */}
        <TouchableOpacity
          style={[
            styles.toggleButton,
            recording ? styles.toggleStop : styles.toggleStart,
            !connected && styles.toggleDisabled,
          ]}
          onPress={handleToggleRecording}
          disabled={!connected}
        >
          <Text style={styles.toggleText}>
            {recording ? 'Stop & Send' : 'Start Testing'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    padding: 24,
    paddingTop: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#e0e0e0',
    marginBottom: 20,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  statusConnected: {
    backgroundColor: '#22c55e',
  },
  statusDisconnected: {
    backgroundColor: '#ef4444',
  },
  statusText: {
    color: '#e0e0e0',
    fontSize: 15,
  },
  infoRow: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 20,
    paddingLeft: 20,
  },
  infoText: {
    color: '#888',
    fontSize: 13,
  },
  label: {
    color: '#999',
    fontSize: 13,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e0e0e0',
    fontSize: 15,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  discoverButton: {
    backgroundColor: 'rgba(99,102,241,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.4)',
  },
  connectButton: {
    backgroundColor: '#6366f1',
  },
  buttonText: {
    color: '#e0e0e0',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#ef4444',
    fontSize: 13,
    marginTop: 12,
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ef4444',
    marginRight: 8,
  },
  recordingText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  toggleButton: {
    marginTop: 24,
    paddingVertical: 18,
    borderRadius: 14,
    alignItems: 'center',
  },
  toggleStart: {
    backgroundColor: '#22c55e',
  },
  toggleStop: {
    backgroundColor: '#ef4444',
  },
  toggleDisabled: {
    opacity: 0.4,
  },
  toggleText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
});
