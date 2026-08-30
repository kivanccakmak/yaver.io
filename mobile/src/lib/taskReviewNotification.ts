export const TASK_REVIEW_NOTIFICATION_CHANNEL_ID = "yaver-task-review";

export function shouldNotifyTaskReview(
  previousStatus: string | null | undefined,
  nextStatus: string | null | undefined,
): boolean {
  return nextStatus === "review" && (previousStatus === "running" || previousStatus === "queued");
}

let notificationHandlerInstalled = false;

function reviewBody(title: string): string {
  const text = String(title || "").trim();
  return text || "A coding task is ready to review.";
}

export async function notifyTaskNeedsReview(title: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Notifications: any = require("expo-notifications");
    if (!Notifications) return false;

    if (!notificationHandlerInstalled && typeof Notifications.setNotificationHandler === "function") {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
      notificationHandlerInstalled = true;
    }

    let permission = await Notifications.getPermissionsAsync();
    if (permission?.status !== "granted") {
      if (permission?.canAskAgain === false) return false;
      permission = await Notifications.requestPermissionsAsync();
      if (permission?.status !== "granted") return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require("react-native");
    if (Platform?.OS === "android" && typeof Notifications.setNotificationChannelAsync === "function") {
      await Notifications.setNotificationChannelAsync(TASK_REVIEW_NOTIFICATION_CHANNEL_ID, {
        name: "Task review",
        importance: Notifications.AndroidImportance?.HIGH ?? 4,
      });
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Task needs review",
        body: reviewBody(title),
        sound: "default",
        data: { kind: "task-review" },
      },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}
