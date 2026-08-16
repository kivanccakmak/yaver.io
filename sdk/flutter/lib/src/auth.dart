import 'dart:convert';

import 'package:http/http.dart' as http;

import 'types.dart';

const _defaultConvexUrl =
    'https://perceptive-minnow-557.eu-west-1.convex.site';

/// Auth client for the Yaver Convex backend.
///
/// Handles token validation, device listing, and settings management.
class YaverAuthClient {
  final String convexURL;
  final String authToken;
  final Duration timeout;
  final http.Client _httpClient;

  YaverAuthClient(
    this.authToken, {
    String? convexURL,
    this.timeout = const Duration(seconds: 10),
    http.Client? httpClient,
  })  : convexURL = (convexURL ?? _defaultConvexUrl).replaceAll(RegExp(r'/$'), ''),
        _httpClient = httpClient ?? http.Client();

  /// Validate the auth token and return user info.
  Future<User> validateToken() async {
    final result = await _get('/auth/validate');
    return User.fromJson(result['user'] as Map<String, dynamic>);
  }

  /// List registered devices.
  Future<List<Device>> listDevices() async {
    final result = await _get('/devices');
    return (result['devices'] as List)
        .map((d) => Device.fromJson(d as Map<String, dynamic>))
        .toList();
  }

  /// Get user settings.
  Future<UserSettings> getSettings() async {
    final result = await _get('/settings');
    final settings = result['settings'];
    if (settings == null) return UserSettings();
    return UserSettings.fromJson(settings as Map<String, dynamic>);
  }

  /// Save user settings.
  Future<void> saveSettings(UserSettings settings) =>
      _post('/settings', settings.toJson());

  /// Close the underlying HTTP client.
  void close() => _httpClient.close();

  // ── HTTP helpers ─────────────────────────────────────────────────

  Future<Map<String, dynamic>> _get(String path) async {
    final url = Uri.parse('$convexURL$path');
    final resp = await _httpClient.get(url, headers: {
      'Authorization': 'Bearer $authToken',
    }).timeout(timeout);
    if (resp.statusCode >= 400) {
      throw Exception('HTTP ${resp.statusCode}');
    }
    return jsonDecode(resp.body) as Map<String, dynamic>;
  }

  Future<void> _post(String path, Map<String, dynamic> body) async {
    final url = Uri.parse('$convexURL$path');
    await _httpClient.post(
      url,
      headers: {
        'Authorization': 'Bearer $authToken',
        'Content-Type': 'application/json',
      },
      body: jsonEncode(body),
    ).timeout(timeout);
  }
}
