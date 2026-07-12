import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.atpx.stdhub',
  appName: '标准盒子',
  webDir: 'public',
  ios: {
    contentInset: 'automatic',
    scrollEnabled: true,
  },
};

export default config;
