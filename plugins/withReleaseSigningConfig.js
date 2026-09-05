// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

const path = require('path');
const fs = require('fs');
const { withAppBuildGradle } = require('@expo/config-plugins');

// Wires the real upload/release keystore (generated 2026-07-31, see
// keystore/CREDENTIALS_README.txt) into android/app/build.gradle's release
// signingConfig, replacing the template's debug-keystore fallback. Reads
// credentials from process.env (populated from .env by expo prebuild's own
// dotenv loading) rather than hardcoding anything here, since this file is
// committed and the keystore/passwords must never be.
//
// Deliberately a graceful no-op (falls back to the existing debug-signed
// release build, unchanged) when the env vars aren't set — this is what
// keeps GitHub Actions' CI checkout working with zero changes needed there:
// it never has keystore/ (gitignored, never committed), so this plugin
// just does nothing on that machine and CI stays on debug signing as
// before. Only a machine with the real keystore configured (via .env)
// gets real release signing.
const KEYSTORE_PATH = process.env.RELEASE_KEYSTORE_PATH;
const KEYSTORE_PASSWORD = process.env.RELEASE_KEYSTORE_PASSWORD;
const KEY_ALIAS = process.env.RELEASE_KEY_ALIAS;
const KEY_PASSWORD = process.env.RELEASE_KEY_PASSWORD;

const ORIGINAL_SIGNING_CONFIGS = `signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

const ORIGINAL_RELEASE_SIGNING_LINE = `release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

module.exports = function withReleaseSigningConfig(config) {
  if (!KEYSTORE_PATH || !KEYSTORE_PASSWORD || !KEY_ALIAS || !KEY_PASSWORD) {
    console.log(
      'withReleaseSigningConfig: RELEASE_KEYSTORE_* env vars not set — release build stays debug-signed (expected on CI/other machines without the real keystore).'
    );
    return config;
  }

  const absoluteKeystorePath = path.isAbsolute(KEYSTORE_PATH)
    ? KEYSTORE_PATH
    : path.join(__dirname, '..', KEYSTORE_PATH);

  if (!fs.existsSync(absoluteKeystorePath)) {
    throw new Error(
      `withReleaseSigningConfig: RELEASE_KEYSTORE_PATH is set but no file exists at ${absoluteKeystorePath}`
    );
  }

  // Gradle's file() on Windows is happier with forward slashes.
  const gradleKeystorePath = absoluteKeystorePath.replace(/\\/g, '/');

  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withReleaseSigningConfig expects a Groovy android/app/build.gradle');
    }
    if (!config.modResults.contents.includes(ORIGINAL_SIGNING_CONFIGS)) {
      throw new Error(
        'withReleaseSigningConfig: expected signingConfigs block not found in android/app/build.gradle — template may have changed'
      );
    }
    if (!config.modResults.contents.includes(ORIGINAL_RELEASE_SIGNING_LINE)) {
      throw new Error(
        'withReleaseSigningConfig: expected release buildType signingConfig line not found in android/app/build.gradle — template may have changed'
      );
    }

    config.modResults.contents = config.modResults.contents.replace(
      ORIGINAL_SIGNING_CONFIGS,
      `signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            storeFile file('${gradleKeystorePath}')
            storePassword '${KEYSTORE_PASSWORD}'
            keyAlias '${KEY_ALIAS}'
            keyPassword '${KEY_PASSWORD}'
        }
    }`
    );

    config.modResults.contents = config.modResults.contents.replace(
      ORIGINAL_RELEASE_SIGNING_LINE,
      `release {
            // Real upload/release keystore — see keystore/CREDENTIALS_README.txt.
            // Injected by plugins/withReleaseSigningConfig.js from .env, never
            // hardcoded here (this file is generated fresh by every prebuild).
            signingConfig signingConfigs.release`
    );

    return config;
  });
};
