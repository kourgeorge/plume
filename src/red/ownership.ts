import { googleConnected, searchConsoleVerified } from '../analytics/google';
import { ghConfigured } from '../github';
import { siteEnv } from '../integrations';

/**
 * What Plume-Red (the security side of Plume) is allowed to do for the current site.
 *
 * The whole feature is OFF unless the site has a Google connection — Analytics or Search Console.
 * That connection is the switch the user asked for. But the two connections are not equally strong
 * proof that the user owns the site:
 *
 *  - Analytics only: a tracking tag can be dropped on any page, so this proves the user can edit the
 *    site, not that they own the domain. Enough to read what the site already returns to everyone
 *    (headers, TLS, version strings) and to read a repo the user linked. NOT enough to send any
 *    request the site didn't already answer for every visitor.
 *  - Search Console: Google only grants it after verifying domain control (DNS record, file upload,
 *    or an existing GA/GTM link it checks). This is real ownership proof, so it unlocks the one
 *    passive check that actively asks the server for things — probing for files like `.env` that a
 *    site should never expose — and it is the floor for any active testing.
 *
 * A linked GitHub repo is independent proof: the user handed over a token scoped to that repo, so
 * reading its files (lockfiles, committed secrets) is always allowed once a repo is connected.
 *
 * Everything here fails closed: if we can't confirm a capability, it is off.
 */
export interface RedPermissions {
  /** The feature is available at all (some Google connection exists). */
  enabled: boolean;
  /** Read-only checks on what the server already returns to any visitor. */
  passiveHeaders: boolean;
  /** Read files from the connected GitHub repo (dependencies, secrets). */
  repoScan: boolean;
  /** Ask the live site for paths it shouldn't expose. Needs verified ownership. */
  fileProbe: boolean;
  /** Non-destructive active testing (reflected markers, open redirects). Needs verified ownership AND a per-scan OK. */
  activeTesting: boolean;
  /** One line explaining the current level, for the UI. */
  reason: string;
}

export function redPermissions(env: NodeJS.ProcessEnv = siteEnv()): RedPermissions {
  const connected = googleConnected();
  const verified = connected && searchConsoleVerified();
  const repo = ghConfigured(env);

  if (!connected) {
    return {
      enabled: false,
      passiveHeaders: false,
      repoScan: repo, // a repo alone still lets us read what the user linked, but the feature UI stays hidden until Google is connected
      fileProbe: false,
      activeTesting: false,
      reason: 'Connect Google (Analytics or Search Console) to turn on Plume-Red.',
    };
  }
  if (!verified) {
    return {
      enabled: true,
      passiveHeaders: true,
      repoScan: repo,
      fileProbe: false,
      activeTesting: false,
      reason:
        'On with Analytics. Reading what your site already shows everyone' +
        (repo ? ' and your linked code' : '') +
        '. Connect Search Console to let Plume check for exposed files — Google verifies you own the domain first.',
    };
  }
  return {
    enabled: true,
    passiveHeaders: true,
    repoScan: repo,
    fileProbe: true,
    activeTesting: true, // the capability is unlocked; the scan still asks for an explicit OK each time (see scan.ts)
    reason: 'On with Search Console. Google has verified you own this domain.',
  };
}
