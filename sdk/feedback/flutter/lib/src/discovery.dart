import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

/// Result of a successful agent discovery or probe.
class DiscoveryResult {
  /// The base URL of the discovered agent (e.g. `http://192.168.1.42:18080`).
  final String url;

  /// The hostname reported by the agent.
  final String hostname;

  /// The agent version string.
  final String version;

  /// Round-trip latency in milliseconds measured during the probe.
  final int latencyMs;

  /// Creates a new [DiscoveryResult].
  const DiscoveryResult({
    required this.url,
    required this.hostname,
    required this.version,
    required this.latencyMs,
  });

  @override
  String toString() =>
      'DiscoveryResult(url: $url, hostname: $hostname, version: $version, latencyMs: ${latencyMs}ms)';
}

/// Discovers Yaver agents on the local network.
///
/// Provides auto-discovery by scanning common LAN subnets for a Yaver agent
/// `/health` endpoint, manual connection to a known URL, and in-memory caching
/// of the last successful result.
///
/// ```dart
/// // Auto-discover (checks cached, then scans LAN)
/// final agent = await YaverDiscovery.discover();
///
/// // Or connect to a known host
/// final agent = await YaverDiscovery.connect('http://192.168.1.42:18080');
/// ```
class YaverDiscovery {
  YaverDiscovery._();

  /// Storage key for persisting the last known agent URL.
  static const _storageKey = 'yaver_feedback_agent';

  /// Default Yaver agent HTTP port.
  static const _defaultPort = 18080;

  /// Timeout for a single probe request in milliseconds.
  static const _timeoutMs = 2000;

  /// In-memory cache of the last successful discovery result.
  static DiscoveryResult? _cached;

  /// Common LAN subnet prefixes to scan.
  static const _subnets = [
    '192.168.1.',
    '192.168.0.',
    '10.0.0.',
    '10.0.1.',
    '172.16.0.',
  ];

  /// Returns the cached discovery result, if any.
  static DiscoveryResult? get cached => _cached;

  /// Clears the cached discovery result.
  static void clearCache() {
    _cached = null;
  }

  /// Auto-discover an agent: check the cached result first, then scan the LAN.
  ///
  /// Returns `null` if no agent is found.
  static Future<DiscoveryResult?> discover() async {
    // 1. Check cached result
    if (_cached != null) {
      final result = await probe(_cached!.url);
      if (result != null) return result;
      _cached = null;
    }

    // 2. Scan common LAN subnets
    return _scanLAN();
  }

  /// Probes a specific URL to check if a Yaver agent is reachable.
  ///
  /// Hits `<url>/health` and expects a JSON response with `hostname` and
  /// `version` fields. Returns `null` if the probe fails or times out.
  static Future<DiscoveryResult?> probe(String url) async {
    final normalized = url.endsWith('/') ? url.substring(0, url.length - 1) : url;
    final uri = Uri.parse('$normalized/health');

    try {
      final stopwatch = Stopwatch()..start();
      final response = await http
          .get(uri)
          .timeout(Duration(milliseconds: _timeoutMs));
      stopwatch.stop();

      if (response.statusCode == 200) {
        final body = jsonDecode(response.body) as Map<String, dynamic>;
        final result = DiscoveryResult(
          url: normalized,
          hostname: body['hostname'] as String? ?? 'unknown',
          version: body['version'] as String? ?? 'unknown',
          latencyMs: stopwatch.elapsedMilliseconds,
        );
        _cached = result;
        return result;
      }
    } on TimeoutException {
      // Probe timed out
    } on SocketException {
      // Host unreachable
    } on http.ClientException {
      // Connection refused or other HTTP error
    } on FormatException {
      // Invalid JSON response
    } catch (e) {
      debugPrint('YaverDiscovery: probe error for $url: $e');
    }

    return null;
  }

  /// Manually connect to a known agent URL, verify it, and cache the result.
  ///
  /// This is the recommended method when the user enters an IP/URL manually.
  /// Returns `null` if the agent is not reachable.
  static Future<DiscoveryResult?> connect(String url) async {
    // Ensure the URL has a scheme
    var normalized = url.trim();
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = 'http://$normalized';
    }

    // Ensure port is present
    final uri = Uri.parse(normalized);
    if (uri.port == 0 || (uri.port == 80 && !normalized.contains(':$_defaultPort'))) {
      normalized = '${uri.scheme}://${uri.host}:$_defaultPort';
    }

    final result = await probe(normalized);
    if (result != null) {
      _cached = result;
    }
    return result;
  }

  /// Scans common LAN subnets by probing IPs concurrently.
  ///
  /// Probes common gateway-adjacent IPs (1-20, 100-110, 200-210) on each
  /// subnet. Returns the first successful result.
  static Future<DiscoveryResult?> _scanLAN() async {
    // Build a list of candidate IPs
    final candidates = <String>[];

    // Common host ranges — gateway-adjacent IPs and DHCP ranges
    const hostRanges = [
      [1, 20],
      [100, 110],
      [200, 210],
    ];

    for (final subnet in _subnets) {
      for (final range in hostRanges) {
        for (var i = range[0]; i <= range[1]; i++) {
          candidates.add('http://$subnet$i:$_defaultPort');
        }
      }
    }

    debugPrint('YaverDiscovery: scanning ${candidates.length} LAN addresses...');

    // Probe in batches to avoid overwhelming the network
    const batchSize = 30;

    for (var i = 0; i < candidates.length; i += batchSize) {
      final batch = candidates.skip(i).take(batchSize).toList();

      final futures = batch.map((url) => probe(url));
      final results = await Future.wait(futures);

      for (final result in results) {
        if (result != null) {
          debugPrint('YaverDiscovery: found agent at ${result.url}');
          return result;
        }
      }
    }

    debugPrint('YaverDiscovery: no agents found on LAN');
    return null;
  }
}
