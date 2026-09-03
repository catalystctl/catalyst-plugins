/**
 * CS 1.6 Admin — frontend entry.
 * Registers the per-server management tab.
 */

import { createFrontendPlugin } from '@catalyst/plugin-sdk/frontend';
import { Cs16ServerTab } from './components';

export default createFrontendPlugin({
  manifest: {
    name: 'cs16-admin',
    version: '1.1.0',
    displayName: 'CS 1.6 Server Admin',
    description: 'Live management for CS 1.6 servers: chat, players, rounds, kick, ban and match control',
    author: 'Catalyst Team',
  },
  tabs: [
    {
      id: 'cs16-admin',
      label: 'CS 1.6 Admin',
      icon: 'Crosshair',
      component: Cs16ServerTab,
      location: 'server',
      order: 20,
      requiredPermissions: ['server.read'],
      // Only CS 1.6 / HLDS-CStrike game servers: match CS 1.6 template names
      // (never Counter-Strike 2 / Source) or a cstrike HLDS configuration.
      templateFilter: {
        namePattern:
          '(counter[ -]?strike|\\bcs\\b|\\bhlds\\b|cstrike)[\\s\\S]*1\\.6|1\\.6[\\s\\S]*(counter[ -]?strike|\\bcs\\b|\\bhlds\\b|cstrike)|cstrike',
        env: { HLDS_GAME: 'cstrike' },
      },
    },
  ],
});
