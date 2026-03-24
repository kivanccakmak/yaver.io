import React, { useRef } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

interface FloatingButtonProps {
  onPress: () => void;
}

const BUTTON_SIZE = 48;

/**
 * A small draggable floating button that sits on top of the app.
 * Tap to trigger feedback collection. Drag to reposition.
 */
export const FloatingButton: React.FC<FloatingButtonProps> = ({ onPress }) => {
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

  const pan = useRef(
    new Animated.ValueXY({
      x: screenWidth - BUTTON_SIZE - 16,
      y: screenHeight * 0.7,
    }),
  ).current;

  const isDragging = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Only claim the gesture if the user is actually dragging
        return Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5;
      },
      onPanResponderGrant: () => {
        pan.extractOffset();
        isDragging.current = false;
      },
      onPanResponderMove: (_, gestureState) => {
        if (Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5) {
          isDragging.current = true;
        }
        Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false,
        })(_, gestureState);
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        if (!isDragging.current) {
          onPress();
        }
      },
    }),
  ).current;

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: [{ translateX: pan.x }, { translateY: pan.y }] },
      ]}
      {...panResponder.panHandlers}
    >
      <TouchableOpacity
        style={styles.button}
        activeOpacity={0.8}
        onPress={onPress}
      >
        <Text style={styles.label}>Y</Text>
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    zIndex: 9999,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: 'rgba(99, 102, 241, 0.85)',
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
});
