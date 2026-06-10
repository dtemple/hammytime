import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  // The calendar route and the prehab routine page read the exercise corpus at
  // runtime to resolve exercise source links. The file lives under worker/ —
  // outside their traced module graphs — so trace it explicitly into each bundle.
  outputFileTracingIncludes: {
    '/api/calendar/[token]': ['./worker/knowledge/exercises.md'],
    '/prehab/[token]': ['./worker/knowledge/exercises.md'],
  },
  async rewrites() {
    return [
      // Global reference page (Specs/PREHAB.md): /glossary is a plain static
      // route. The page is a self-contained HTML document in public/, so serve
      // it at the clean path rather than /glossary.html.
      { source: '/glossary', destination: '/glossary.html' },
    ];
  },
  async headers() {
    return [
      {
        // Unguessable-token page: belt-and-braces noindex alongside the page's
        // robots metadata. Scoped narrowly so future public pages are unaffected.
        source: '/prehab/:token',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: 'david-temple',

  project: 'hammytime',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: '/monitoring',

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
