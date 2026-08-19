import SwiftUI
import WidgetKit

#if canImport(ActivityKit)
import ActivityKit

/// The widget extension's entry point — one Live Activity, drawn on the Lock
/// Screen, the Dynamic Island, the Watch Smart Stack, and the CarPlay Dashboard.
///
/// `supplementalActivityFamilies` arrived in the iOS 18.4 SDK and is the hook
/// that makes this Live Activity eligible for the CarPlay Dashboard. Yaver's
/// local Apple worker may still carry Xcode 16.2 / iOS 18.2, so the source has
/// two compile-time configurations: newer compilers include the CarPlay hook;
/// older compilers still ship the same Lock Screen / Dynamic Island / Watch
/// activity. This avoids making the entire phone archive depend on one newer
/// SDK while preserving CarPlay automatically as soon as the worker upgrades.
@available(iOS 16.2, *)
@main
struct YaverWidgetBundle: WidgetBundle {
    var body: some Widget {
        YaverActivityWidget()
    }
}

@available(iOS 16.2, *)
struct YaverActivityWidget: Widget {
#if compiler(>=6.1)
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: YaverActivityAttributes.self) { context in
            // Lock Screen + CarPlay Dashboard + Watch Smart Stack.
            YaverActivityCompactView(
                state: context.state,
                machine: context.attributes.machine
            )
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: YaverActivityStyle.glyph(context.state.status))
                        .foregroundStyle(YaverActivityStyle.tint(context.state.status))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.attributes.machine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.headline)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } compactLeading: {
                Image(systemName: YaverActivityStyle.glyph(context.state.status))
                    .foregroundStyle(YaverActivityStyle.tint(context.state.status))
            } compactTrailing: {
                Text(context.attributes.machine.prefix(4))
                    .font(.caption2)
            } minimal: {
                Image(systemName: YaverActivityStyle.glyph(context.state.status))
                    .foregroundStyle(YaverActivityStyle.tint(context.state.status))
            }
        }
        // The one line that reaches the car. The extension's iOS 18 floor
        // matches this API; the containing phone app keeps its older floor.
        .supplementalActivityFamilies([.small])
    }
#else
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: YaverActivityAttributes.self) { context in
            YaverActivityCompactView(
                state: context.state,
                machine: context.attributes.machine
            )
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: YaverActivityStyle.glyph(context.state.status))
                        .foregroundStyle(YaverActivityStyle.tint(context.state.status))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.attributes.machine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.headline)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } compactLeading: {
                Image(systemName: YaverActivityStyle.glyph(context.state.status))
                    .foregroundStyle(YaverActivityStyle.tint(context.state.status))
            } compactTrailing: {
                Text(context.attributes.machine.prefix(4))
                    .font(.caption2)
            } minimal: {
                Image(systemName: YaverActivityStyle.glyph(context.state.status))
                    .foregroundStyle(YaverActivityStyle.tint(context.state.status))
            }
        }
    }
#endif
}
#endif
