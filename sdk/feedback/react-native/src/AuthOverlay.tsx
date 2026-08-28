import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, DeviceEventEmitter, Modal } from 'react-native';
import { YaverLoginScreen } from './LoginScreen';
import { YaverMachinePickerScreen } from './MachinePickerScreen';
import { YaverFeedback } from './YaverFeedback';
import { getToken, RemoteDevice } from './auth';

/** Owner sign-in and owner-machine selection for the Feedback SDK. */
export const AuthOverlay: React.FC = () => {
  const [loginVisible, setLoginVisible] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const activeOverlayRef = useRef<'none' | 'login' | 'picker'>('none');

  const openLogin = useCallback(() => {
    activeOverlayRef.current = 'login';
    setPickerVisible(false);
    setLoginVisible(true);
  }, []);

  const openPicker = useCallback(() => {
    activeOverlayRef.current = 'picker';
    setLoginVisible(false);
    setPickerVisible(true);
  }, []);

  const closeAll = useCallback(() => {
    activeOverlayRef.current = 'none';
    setLoginVisible(false);
    setPickerVisible(false);
  }, []);

  const continueDogfood = useCallback(async () => {
    try {
      const state = await YaverFeedback.continueDogfoodOnboarding();
      if (state.phase === 'denied' || state.phase === 'error') {
        Alert.alert(
          'Dogfood unavailable',
          state.error || 'This Yaver account or device is not enabled for this app.',
        );
      }
    } catch (cause) {
      Alert.alert(
        'Dogfood unavailable',
        cause instanceof Error ? cause.message : 'Yaver could not continue Dogfood setup.',
      );
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void getToken().then((cached) => {
      if (mounted && cached) setToken(cached);
    });
    const loginSub = DeviceEventEmitter.addListener('yaverFeedback:startLogin', () => {
      if (activeOverlayRef.current === 'none') openLogin();
    });
    const pickerSub = DeviceEventEmitter.addListener('yaverFeedback:startMachinePicker', async () => {
      if (activeOverlayRef.current !== 'none') return;
      const cached = await getToken();
      if (cached) {
        setToken(cached);
        openPicker();
      }
    });
    return () => {
      mounted = false;
      loginSub.remove();
      pickerSub.remove();
    };
  }, [openLogin, openPicker]);

  const handleLoggedIn = async (newToken: string) => {
    setToken(newToken);
    await YaverFeedback.setAuthToken(newToken);
    if (YaverFeedback.getDogfoodOnboarding()) {
      closeAll();
      await continueDogfood();
    } else {
      openPicker();
    }
  };

  const handleDevicePicked = async (device: RemoteDevice) => {
    await YaverFeedback.setPreferredDevice(device.deviceId);
    closeAll();
    if (YaverFeedback.getDogfoodOnboarding()) {
      await continueDogfood();
    } else {
      DeviceEventEmitter.emit('yaverFeedback:startReport');
    }
  };

  return (
    <>
      <Modal visible={loginVisible} animationType="slide" presentationStyle="fullScreen" onRequestClose={closeAll}>
        <YaverLoginScreen onLoggedIn={handleLoggedIn} onCancel={closeAll} />
      </Modal>
      <Modal visible={pickerVisible && !!token} animationType="slide" presentationStyle="fullScreen" onRequestClose={closeAll}>
        {token && (
          <YaverMachinePickerScreen
            token={token}
            currentDeviceId={YaverFeedback.getConfig()?.preferredDeviceId}
            onPick={handleDevicePicked}
            onCancel={closeAll}
          />
        )}
      </Modal>
    </>
  );
};
