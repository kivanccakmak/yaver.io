import 'dart:async';

import 'package:flutter/material.dart';

import 'discovery.dart';
import 'p2p_client.dart';

/// Connection status for the Yaver agent.
enum ConnectionStatus {
  /// No connection attempt has been made.
  disconnected,

  /// Currently scanning/connecting.
  connecting,

  /// Connected to an agent.
  connected,

  /// Connection or discovery failed.
  error,
}

/// A Flutter widget for discovering and connecting to a Yaver agent.
///
/// Displays connection status, provides a URL input for manual connection,
/// an auto-discover button, and a start/stop testing toggle. Also shows
/// agent commentary messages when connected.
///
/// Uses a dark theme matching the feedback overlay styling.
///
/// ```dart
/// YaverConnectionWidget(
///   authToken: 'your-token',
///   onConnected: (client) {
///     // Use the P2PClient
///   },
/// )
/// ```
class YaverConnectionWidget extends StatefulWidget {
  /// Auth token for the Yaver agent.
  final String authToken;

  /// Called when a connection is established.
  final void Function(P2PClient client)? onConnected;

  /// Called when the connection is lost or disconnected.
  final VoidCallback? onDisconnected;

  /// Called when the testing toggle changes.
  final void Function(bool isTesting)? onTestingToggled;

  /// Agent commentary level (0-10). Messages below this level are hidden.
  final int commentaryLevel;

  /// Creates a new [YaverConnectionWidget].
  const YaverConnectionWidget({
    super.key,
    required this.authToken,
    this.onConnected,
    this.onDisconnected,
    this.onTestingToggled,
    this.commentaryLevel = 5,
  });

  @override
  State<YaverConnectionWidget> createState() => _YaverConnectionWidgetState();
}

class _YaverConnectionWidgetState extends State<YaverConnectionWidget> {
  final _urlController = TextEditingController();
  ConnectionStatus _status = ConnectionStatus.disconnected;
  DiscoveryResult? _discoveryResult;
  P2PClient? _client;
  String? _errorMessage;
  bool _isTesting = false;
  Timer? _commentaryTimer;
  final List<_CommentaryMessage> _commentary = [];
  int _lastCommentaryTimestamp = 0;

  @override
  void initState() {
    super.initState();
    // Check if there's a cached discovery result
    if (YaverDiscovery.cached != null) {
      _urlController.text = YaverDiscovery.cached!.url;
    }
  }

  @override
  void dispose() {
    _urlController.dispose();
    _commentaryTimer?.cancel();
    _client?.dispose();
    super.dispose();
  }

  Future<void> _discover() async {
    setState(() {
      _status = ConnectionStatus.connecting;
      _errorMessage = null;
    });

    final result = await YaverDiscovery.discover();

    if (!mounted) return;

    if (result != null) {
      _urlController.text = result.url;
      _onDiscovered(result);
    } else {
      setState(() {
        _status = ConnectionStatus.error;
        _errorMessage = 'No agents found on local network';
      });
    }
  }

  Future<void> _connectManual() async {
    final url = _urlController.text.trim();
    if (url.isEmpty) return;

    setState(() {
      _status = ConnectionStatus.connecting;
      _errorMessage = null;
    });

    final result = await YaverDiscovery.connect(url);

    if (!mounted) return;

    if (result != null) {
      _onDiscovered(result);
    } else {
      setState(() {
        _status = ConnectionStatus.error;
        _errorMessage = 'Could not connect to $url';
      });
    }
  }

  void _onDiscovered(DiscoveryResult result) {
    final client = P2PClient(
      baseUrl: result.url,
      authToken: widget.authToken,
    );

    setState(() {
      _discoveryResult = result;
      _client = client;
      _status = ConnectionStatus.connected;
    });

    widget.onConnected?.call(client);
    _startCommentaryPolling();
  }

  void _disconnect() {
    _commentaryTimer?.cancel();
    _client?.dispose();

    setState(() {
      _status = ConnectionStatus.disconnected;
      _discoveryResult = null;
      _client = null;
      _isTesting = false;
      _commentary.clear();
      _lastCommentaryTimestamp = 0;
    });

    widget.onDisconnected?.call();
  }

  void _toggleTesting() {
    setState(() {
      _isTesting = !_isTesting;
    });
    widget.onTestingToggled?.call(_isTesting);
  }

  void _startCommentaryPolling() {
    _commentaryTimer?.cancel();
    _commentaryTimer = Timer.periodic(
      const Duration(seconds: 2),
      (_) => _fetchCommentary(),
    );
  }

  Future<void> _fetchCommentary() async {
    if (_client == null || _status != ConnectionStatus.connected) return;

    try {
      final messages =
          await _client!.getCommentary(since: _lastCommentaryTimestamp);

      if (!mounted || messages.isEmpty) return;

      setState(() {
        for (final msg in messages) {
          final level = (msg['level'] as num?)?.toInt() ?? 5;
          if (level <= widget.commentaryLevel) {
            _commentary.add(_CommentaryMessage(
              text: msg['text'] as String? ?? '',
              level: level,
              timestamp: DateTime.now(),
            ));
          }
          final ts = (msg['timestamp'] as num?)?.toInt() ?? 0;
          if (ts > _lastCommentaryTimestamp) {
            _lastCommentaryTimestamp = ts;
          }
        }

        // Keep at most 50 messages
        if (_commentary.length > 50) {
          _commentary.removeRange(0, _commentary.length - 50);
        }
      });
    } catch (_) {
      // Commentary fetch is best-effort
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF1A1A2E),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: const Color(0xFF2A2A4A),
          width: 1,
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header with status indicator
          _buildHeader(),
          const SizedBox(height: 12),

          // URL input and connect controls
          if (_status != ConnectionStatus.connected) ...[
            _buildUrlInput(),
            const SizedBox(height: 12),
            _buildActionButtons(),
          ],

          // Connected info
          if (_status == ConnectionStatus.connected) ...[
            _buildConnectedInfo(),
            const SizedBox(height: 12),
            _buildTestingToggle(),
          ],

          // Error message
          if (_errorMessage != null) ...[
            const SizedBox(height: 8),
            _buildErrorMessage(),
          ],

          // Commentary messages
          if (_commentary.isNotEmpty) ...[
            const SizedBox(height: 12),
            _buildCommentary(),
          ],
        ],
      ),
    );
  }

  Widget _buildHeader() {
    final Color statusColor;
    final String statusText;
    final IconData statusIcon;

    switch (_status) {
      case ConnectionStatus.disconnected:
        statusColor = const Color(0xFF666680);
        statusText = 'Disconnected';
        statusIcon = Icons.link_off;
        break;
      case ConnectionStatus.connecting:
        statusColor = const Color(0xFFFFAA00);
        statusText = 'Connecting...';
        statusIcon = Icons.sync;
        break;
      case ConnectionStatus.connected:
        statusColor = const Color(0xFF00CC66);
        statusText = 'Connected';
        statusIcon = Icons.link;
        break;
      case ConnectionStatus.error:
        statusColor = const Color(0xFFFF4444);
        statusText = 'Error';
        statusIcon = Icons.error_outline;
        break;
    }

    return Row(
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(
            color: statusColor,
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                color: statusColor.withOpacity(0.4),
                blurRadius: 6,
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Icon(statusIcon, color: statusColor, size: 18),
        const SizedBox(width: 6),
        Text(
          statusText,
          style: TextStyle(
            color: statusColor,
            fontWeight: FontWeight.w600,
            fontSize: 14,
          ),
        ),
        const Spacer(),
        if (_status == ConnectionStatus.connected)
          IconButton(
            icon: const Icon(Icons.close, color: Color(0xFF666680), size: 18),
            onPressed: _disconnect,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
      ],
    );
  }

  Widget _buildUrlInput() {
    return TextField(
      controller: _urlController,
      style: const TextStyle(color: Colors.white, fontSize: 14),
      decoration: InputDecoration(
        hintText: '192.168.1.100:18080',
        hintStyle: const TextStyle(color: Color(0xFF666680)),
        filled: true,
        fillColor: const Color(0xFF0F0F23),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF2A2A4A)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF2A2A4A)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF4A4AFF)),
        ),
        prefixIcon:
            const Icon(Icons.computer, color: Color(0xFF666680), size: 18),
      ),
      onSubmitted: (_) => _connectManual(),
    );
  }

  Widget _buildActionButtons() {
    final isConnecting = _status == ConnectionStatus.connecting;

    return Row(
      children: [
        Expanded(
          child: OutlinedButton.icon(
            onPressed: isConnecting ? null : _discover,
            icon: isConnecting
                ? const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Color(0xFF4A4AFF),
                    ),
                  )
                : const Icon(Icons.radar, size: 16),
            label: Text(isConnecting ? 'Scanning...' : 'Discover'),
            style: OutlinedButton.styleFrom(
              foregroundColor: const Color(0xFF4A4AFF),
              side: const BorderSide(color: Color(0xFF4A4AFF)),
              padding: const EdgeInsets.symmetric(vertical: 10),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: FilledButton.icon(
            onPressed: isConnecting ? null : _connectManual,
            icon: const Icon(Icons.link, size: 16),
            label: const Text('Connect'),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF4A4AFF),
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 10),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildConnectedInfo() {
    final result = _discoveryResult;
    if (result == null) return const SizedBox.shrink();

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF0F0F23),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFF2A2A4A)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _infoRow('Host', result.hostname),
          const SizedBox(height: 4),
          _infoRow('URL', result.url),
          const SizedBox(height: 4),
          _infoRow('Version', result.version),
          const SizedBox(height: 4),
          _infoRow('Latency', '${result.latencyMs}ms'),
        ],
      ),
    );
  }

  Widget _infoRow(String label, String value) {
    return Row(
      children: [
        SizedBox(
          width: 60,
          child: Text(
            label,
            style: const TextStyle(
              color: Color(0xFF666680),
              fontSize: 12,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontFamily: 'monospace',
            ),
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }

  Widget _buildTestingToggle() {
    return GestureDetector(
      onTap: _toggleTesting,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: _isTesting
              ? const Color(0xFF00CC66).withOpacity(0.1)
              : const Color(0xFF0F0F23),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: _isTesting
                ? const Color(0xFF00CC66)
                : const Color(0xFF2A2A4A),
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              _isTesting ? Icons.stop_circle : Icons.play_circle,
              color: _isTesting
                  ? const Color(0xFF00CC66)
                  : const Color(0xFF4A4AFF),
              size: 20,
            ),
            const SizedBox(width: 8),
            Text(
              _isTesting ? 'Stop Testing' : 'Start Testing',
              style: TextStyle(
                color: _isTesting
                    ? const Color(0xFF00CC66)
                    : const Color(0xFF4A4AFF),
                fontWeight: FontWeight.w600,
                fontSize: 14,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildErrorMessage() {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFFFF4444).withOpacity(0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFFFF4444).withOpacity(0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber, color: Color(0xFFFF4444), size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _errorMessage!,
              style: const TextStyle(color: Color(0xFFFF4444), fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCommentary() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Agent Commentary',
          style: TextStyle(
            color: Color(0xFF666680),
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 6),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 120),
          child: ListView.builder(
            shrinkWrap: true,
            reverse: true,
            itemCount: _commentary.length,
            itemBuilder: (context, index) {
              final msg = _commentary[_commentary.length - 1 - index];
              return Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _formatTime(msg.timestamp),
                      style: const TextStyle(
                        color: Color(0xFF444460),
                        fontSize: 10,
                        fontFamily: 'monospace',
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        msg.text,
                        style: TextStyle(
                          color: _commentaryColor(msg.level),
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Color _commentaryColor(int level) {
    if (level <= 2) return const Color(0xFF666680);
    if (level <= 5) return const Color(0xFFAABBCC);
    if (level <= 8) return const Color(0xFFFFAA00);
    return const Color(0xFFFF4444);
  }

  String _formatTime(DateTime time) {
    return '${time.hour.toString().padLeft(2, '0')}:'
        '${time.minute.toString().padLeft(2, '0')}:'
        '${time.second.toString().padLeft(2, '0')}';
  }
}

class _CommentaryMessage {
  final String text;
  final int level;
  final DateTime timestamp;

  const _CommentaryMessage({
    required this.text,
    required this.level,
    required this.timestamp,
  });
}
