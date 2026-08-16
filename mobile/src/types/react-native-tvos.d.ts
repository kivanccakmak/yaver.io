import "react-native";

declare module "react-native" {
  interface PressableStateCallbackType {
    /** Present at runtime on React Native tvOS. */
    focused?: boolean;
  }
}
