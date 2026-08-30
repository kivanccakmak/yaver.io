import { useRoute } from "@react-navigation/native";

/**
 * Expo Router 6.0.23's built JS calls `React.use(...)` inside
 * `useLocalSearchParams()`. On the current iOS/TestFlight release lane that
 * default React interop can come through null, which crashes before the screen
 * renders with "Cannot read property 'use' of null". Read params from the
 * underlying React Navigation route instead until the upstream hook is safe.
 */
export function useRouteParamsCompat<T extends Record<string, unknown>>(): Partial<T> {
  const route = useRoute();
  return (route.params ?? {}) as Partial<T>;
}
