/**
 * AI Assistant — frontend entry.
 * Registers an admin tab (all servers) and a server tab (scoped chat).
 */

import { createFrontendPlugin } from '@catalyst/plugin-sdk/frontend';
import { AiAdminTab, AiServerTab } from './components';

export default createFrontendPlugin({
  manifest: {
    name: 'ai-assistant',
    version: '1.0.0',
    displayName: 'AI Assistant',
    description: 'Chat assistant for server configuration, file inspection and log diagnosis',
    author: 'Catalyst Team',
  },
  tabs: [
    {
      id: 'ai-admin',
      label: 'AI Assistant',
      icon: 'Bot',
      component: AiAdminTab,
      location: 'admin',
      order: 60,
      requiredPermissions: ['admin.read'],
    },
    {
      id: 'ai-server',
      label: 'AI Assistant',
      icon: 'Bot',
      component: AiServerTab,
      location: 'server',
      order: 60,
      requiredPermissions: ['server.read'],
    },
  ],
});
