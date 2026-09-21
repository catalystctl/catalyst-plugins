/**
 * OIDC SSO plugin — frontend entry.
 * Registers the admin settings tab.
 */

import { createFrontendPlugin } from '@catalyst/plugin-sdk/frontend';
import { OidcAdminTab } from './components';

export default createFrontendPlugin({
  manifest: {
    name: 'oidc-sso',
    version: '1.0.0',
    displayName: 'OIDC Single Sign-On',
    description: 'Generic OpenID Connect single sign-on for any compliant identity provider',
    author: 'Catalyst Team',
  },
  tabs: [
    {
      id: 'oidc-sso',
      label: 'OIDC Single Sign-On',
      icon: 'KeyRound',
      component: OidcAdminTab,
      location: 'admin',
      order: 85,
      requiredPermissions: ['admin.read'],
    },
  ],
});
