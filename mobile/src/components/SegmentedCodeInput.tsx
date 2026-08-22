// SegmentedCodeInput — GitHub-style short-code entry shared by pairing and
// device approval surfaces.
//
// The boxes are visual only. One real TextInput owns typing, paste, backspace,
// one-time-code autofill, and screen-reader semantics, avoiding the focus and
// deletion bugs caused by six independent inputs.

import React from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useColors } from "../context/ThemeContext";

interface Props {
  value: string;
  onChangeText: (value: string) => void;
  length: number;
  groupEvery?: number;
  testID?: string;
  accessibilityLabel?: string;
}

export default function SegmentedCodeInput({
  value,
  onChangeText,
  length,
  groupEvery,
  testID,
  accessibilityLabel = `Pairing code, ${length} characters`,
}: Props) {
  const c = useColors();
  const inputRef = React.useRef<TextInput>(null);
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, length);

  return (
    <Pressable
      testID={testID}
      accessible={false}
      onPress={() => inputRef.current?.focus()}
      style={styles.pressTarget}
    >
      <View style={styles.boxRow} pointerEvents="none">
        {Array.from({ length }, (_, index) => {
          const active = normalized.length === index || (normalized.length === length && index === length - 1);
          return (
            <View
              key={index}
              style={[
                styles.box,
                { backgroundColor: c.bgCard, borderColor: active ? c.accent : c.border },
                groupEvery && index > 0 && index % groupEvery === 0 ? styles.groupStart : null,
              ]}
            >
              <Text style={[styles.character, { color: c.textPrimary }]}>{normalized[index] ?? ""}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={inputRef}
        value={normalized}
        onChangeText={(next) => onChangeText(next.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, length))}
        maxLength={length}
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        keyboardType={Platform.OS === "ios" ? "ascii-capable" : "visible-password"}
        accessibilityLabel={accessibilityLabel}
        style={styles.realInput}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressTarget: { minHeight: 54, justifyContent: "center" },
  boxRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  box: {
    width: 42,
    height: 50,
    borderWidth: 1.5,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  groupStart: { marginLeft: 8 },
  character: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 21,
    lineHeight: 26,
    fontWeight: "700",
  },
  realInput: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.01,
    color: "transparent",
    backgroundColor: "transparent",
  },
});
