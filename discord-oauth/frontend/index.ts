/**
 * Discord OAuth — frontend entry.
 * Registers the admin settings tab and the profile "connections" card.
 */

import { createFrontendPlugin } from '@catalyst/plugin-sdk/frontend';
import { DiscordAdminTab, DiscordProfileCard } from './components';

export default createFrontendPlugin({
  manifest: {
    name: 'discord-oauth',
    version: '1.0.0',
    displayName: 'Discord OAuth',
    description: 'Sign in with Discord, link accounts, and sync Discord guild roles to panel roles',
    author: 'Catalyst Team',
  },
  tabs: [
    {
      id: 'discord-oauth',
      label: 'Discord OAuth',
      icon: 'MessageCircle',
      component: DiscordAdminTab,
      location: 'admin',
      order: 86,
      requiredPermissions: ['admin.read'],
    },
  ],
  components: [
    {
      slot: 'profile-connections',
      component: DiscordProfileCard,
      order: 10,
    },
  ],
});
