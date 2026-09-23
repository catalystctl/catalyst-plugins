/**
 * Licensed Example — frontend entry.
 *
 * One admin tab: license status and the premium report. Deliberately thin —
 * this UI is NOT encrypted and cannot usefully be; the valuable code lives in
 * the encrypted backend payload.
 */

import { createFrontendPlugin } from '@catalyst/plugin-sdk/frontend';
import { LicensedExampleTab } from './components';

export default createFrontendPlugin({
  manifest: {
    name: 'licensed-example',
    version: '1.0.0',
    displayName: 'Licensed Example',
    description: 'Reference client for vendor-owned license validation and encrypted payloads.',
    author: 'Catalyst Team',
  },
  tabs: [
    {
      id: 'licensed-example',
      label: 'Licensed Example',
      icon: 'KeyRound',
      component: LicensedExampleTab,
      location: 'admin',
      order: 100,
      requiredPermissions: ['admin.read'],
    },
  ],
});
