// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

const { withGradleProperties } = require('@expo/config-plugins');

// GitHub Actions' ubuntu-latest runners are 2-core/7GB — noticeably more
// constrained than this project's local dev machine. A GHA build run
// (30451062778, commit 79993ea) logged Gradle's own diagnostic mid-build:
// "The Daemon will expire after the build after running out of JVM
// Metaspace... currently configured max heap space is '2 GiB' and the
// configured max metaspace is '512 MiB'" — the Expo/RN template default.
// Metaspace pressure causes GC thrashing that slows (not hangs) a build;
// that run went on to hit a 45-minute timeout despite showing continuous
// task progress the whole time (confirmed via `gh run view --log`), so
// this is a genuine contributing factor worth fixing, not just "add more
// timeout." Bumped conservatively — still well within the runner's 7GB.
const JVM_ARGS = '-Xmx3072m -XX:MaxMetaspaceSize=1024m';

module.exports = function withGradleJvmMemory(config) {
  return withGradleProperties(config, (config) => {
    const existing = config.modResults.find(
      (item) => item.type === 'property' && item.key === 'org.gradle.jvmargs'
    );
    if (existing) {
      existing.value = JVM_ARGS;
    } else {
      config.modResults.push({ type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS });
    }
    return config;
  });
};
