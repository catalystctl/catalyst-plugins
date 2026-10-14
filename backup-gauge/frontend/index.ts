/**
 * Backup Gauge — frontend entry.
 *
 * Registers one component into the panel's `server-header-stats` slot, which
 * renders inside the server detail header between DISK and NETWORK.
 */

import { createFrontendPlugin } from '@catalyst/plugin-sdk/frontend';
import { BackupGauge } from './components';

export default createFrontendPlugin({
  manifest: {
    name: 'backup-gauge',
    version: '1.0.0',
    displayName: 'Backup Gauge',
    description: 'Backup storage gauge in the server detail header',
    author: 'Catalyst Team',
  },
  components: [
    {
      slot: 'server-header-stats',
      component: BackupGauge,
      order: 50,
      // The gauge sums this server's backups, so it is only meaningful to a
      // viewer who may read them. Declaring the permission here means the host
      // decides visibility — owners, subusers and roles with backup.read all
      // see it, and it never renders as an empty cell for everyone else.
      requiredPermissions: ['backup.read'],
    },
  ],
});
