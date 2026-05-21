#include "context.h"
#include "hash.h"
#include "zero.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ASSERT(expr, msg) do { if (!(expr)) { fprintf(stderr, "context smoke: %s\n", msg); exit(1); } } while (0)

static char *sha256_json(const char *json, const char *const *excluded) {
  ZBuf canonical;
  zbuf_init(&canonical);
  ASSERT(context_json_canonicalize_excluding(&canonical, json, excluded), "canonicalize expected JSON");
  unsigned char digest[Z_SHA256_DIGEST_LEN];
  char hex[65];
  z_sha256_hash((const unsigned char *)canonical.data, canonical.len, digest);
  z_sha256_hex(digest, hex);
  ZBuf hash;
  zbuf_init(&hash);
  zbuf_append(&hash, "sha256:");
  zbuf_append(&hash, hex);
  zbuf_free(&canonical);
  return hash.data;
}

static void expect_string(const char *actual, const char *expected, const char *message) {
  ASSERT(actual != NULL, message);
  if (strcmp(actual, expected) != 0) {
    fprintf(stderr, "context smoke: %s: expected '%s', got '%s'\n", message, expected, actual);
    exit(1);
  }
}

static void write_small_file(const char *path) {
  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  ASSERT(fd >= 0, "open temp event file");
  const char bytes[] = "{}\n";
  ASSERT(write(fd, bytes, sizeof(bytes) - 1) == (ssize_t)(sizeof(bytes) - 1), "write temp event file");
  close(fd);
}

static void free_strings(char **items, size_t count) {
  for (size_t i = 0; i < count; i++) free(items[i]);
  free(items);
}

static void lifecycle_defaults_to_active_when_absent(void) {
  char *state = context_node_lifecycle_state("{\"nodeId\":\"x\"}");
  expect_string(state, "active", "missing lifecycle defaults active");
  free(state);
}

static void lifecycle_defaults_to_active_when_state_absent(void) {
  char *state = context_node_lifecycle_state("{\"lifecycle\":{}}");
  expect_string(state, "active", "missing lifecycle state defaults active");
  free(state);
}

static void lifecycle_returns_stored_state(void) {
  char *state = context_node_lifecycle_state("{\"lifecycle\":{\"state\":\"superseded\"}}");
  expect_string(state, "superseded", "stored lifecycle state");
  free(state);
}

static const char *event_a =
  "{"
  "\"schemaVersion\":1,"
  "\"kind\":\"context-event\","
  "\"eventId\":\"ctx:event:000001\","
  "\"eventHash\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
  "\"mode\":\"context-check-cycle\","
  "\"sourceFile\":\"example.0\","
  "\"previousRoot\":\"sha256:1111111111111111111111111111111111111111111111111111111111111111\","
  "\"currentRoot\":\"sha256:2222222222222222222222222222222222222222222222222222222222222222\","
  "\"rootChanged\":true,"
  "\"captured\":[],"
  "\"skipped\":[],"
  "\"verification\":{\"ok\":true,\"checkedNodes\":0},"
  "\"diagnostics\":[]"
  "}";

static const char *event_b =
  "{"
  "\"schemaVersion\":1,"
  "\"kind\":\"context-event\","
  "\"eventId\":\"ctx:event:000001\","
  "\"eventHash\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\","
  "\"mode\":\"context-check-cycle\","
  "\"sourceFile\":\"example.0\","
  "\"previousRoot\":\"sha256:1111111111111111111111111111111111111111111111111111111111111111\","
  "\"currentRoot\":\"sha256:2222222222222222222222222222222222222222222222222222222222222222\","
  "\"rootChanged\":true,"
  "\"captured\":[],"
  "\"skipped\":[],"
  "\"verification\":{\"ok\":true,\"checkedNodes\":0},"
  "\"diagnostics\":[]"
  "}";

static void event_hash_excludes_event_hash(void) {
  char *left = context_event_hash(event_a);
  char *right = context_event_hash(event_b);
  ASSERT(left && right, "event hash computes");
  expect_string(left, right, "eventHash exclusion");
  free(left);
  free(right);
}

static void event_hash_is_content_addressed(void) {
  const char *excluded[] = {"eventHash", NULL};
  char *expected = sha256_json(event_a, excluded);
  char *actual = context_event_hash(event_a);
  expect_string(actual, expected, "event hash content address");
  free(expected);
  free(actual);
}

static void root_payload_hash_matches_expected_payload(void) {
  const char *snapshot =
    "{"
    "\"schemaVersion\":1,"
    "\"contextRoot\":\"sha256:ignored\","
    "\"parentRoot\":null,"
    "\"reason\":\"capture-fix-plan\","
    "\"activeNodes\":[\"sha256:b\",\"sha256:a\",\"sha256:a\"],"
    "\"nodes\":[\"sha256:z\"],"
    "\"supersededNodes\":[\"sha256:s2\",\"sha256:s1\",\"sha256:s1\"],"
    "\"archivedNodes\":[\"sha256:r2\",\"sha256:r1\"],"
    "\"createdAt\":\"ignored\","
    "\"indexes\":{\"sourceIndex\":\".zero/context/indexes/source-index.json\"}"
    "}";
  const char *payload =
    "{"
    "\"schemaVersion\":1,"
    "\"parentRoot\":null,"
    "\"reason\":\"capture-fix-plan\","
    "\"activeNodes\":[\"sha256:a\",\"sha256:b\"],"
    "\"nodes\":[\"sha256:a\",\"sha256:b\"],"
    "\"supersededNodes\":[\"sha256:s1\",\"sha256:s2\"],"
    "\"archivedNodes\":[\"sha256:r1\",\"sha256:r2\"],"
    "\"createdAt\":null,"
    "\"indexes\":{\"sourceIndex\":\".zero/context/indexes/source-index.json\"}"
    "}";
  char *expected = sha256_json(payload, NULL);
  char *actual = context_root_payload_hash(snapshot);
  expect_string(actual, expected, "root payload hash");
  free(expected);
  free(actual);
}

static void root_payload_hash_defaults_missing_fields(void) {
  const char *snapshot =
    "{"
    "\"schemaVersion\":1,"
    "\"contextRoot\":\"sha256:ignored\","
    "\"parentRoot\":null,"
    "\"activeNodes\":[\"sha256:a\"]"
    "}";
  char *actual = context_root_payload_hash(snapshot);
  ASSERT(actual != NULL, "root payload defaults missing fields");
  free(actual);
}

static void root_payload_hash_uses_legacy_nodes(void) {
  const char *legacy =
    "{"
    "\"schemaVersion\":1,"
    "\"contextRoot\":\"sha256:ignored\","
    "\"parentRoot\":null,"
    "\"nodes\":[\"sha256:b\",\"sha256:a\"]"
    "}";
  const char *modern =
    "{"
    "\"schemaVersion\":1,"
    "\"contextRoot\":\"sha256:ignored\","
    "\"parentRoot\":null,"
    "\"activeNodes\":[\"sha256:a\",\"sha256:b\"]"
    "}";
  char *left = context_root_payload_hash(legacy);
  char *right = context_root_payload_hash(modern);
  expect_string(left, right, "legacy nodes fallback");
  free(left);
  free(right);
}

static void event_filenames_are_sorted_basenames(void) {
  char dir[128];
  snprintf(dir, sizeof(dir), "/tmp/zero-context-smoke-%ld", (long)getpid());
  char events[160];
  snprintf(events, sizeof(events), "%s/events", dir);
  mkdir(dir, 0700);
  mkdir(events, 0700);
  char path[192];
  snprintf(path, sizeof(path), "%s/c.json", events); write_small_file(path);
  snprintf(path, sizeof(path), "%s/a.json", events); write_small_file(path);
  snprintf(path, sizeof(path), "%s/b.json", events); write_small_file(path);
  snprintf(path, sizeof(path), "%s/skip.txt", events); write_small_file(path);

  size_t count = 0;
  char **names = context_event_filenames(dir, &count);
  ASSERT(count == 3, "event filename count");
  expect_string(names[0], "a.json", "first event filename");
  expect_string(names[1], "b.json", "second event filename");
  expect_string(names[2], "c.json", "third event filename");
  free_strings(names, count);

  snprintf(path, sizeof(path), "%s/a.json", events); unlink(path);
  snprintf(path, sizeof(path), "%s/b.json", events); unlink(path);
  snprintf(path, sizeof(path), "%s/c.json", events); unlink(path);
  snprintf(path, sizeof(path), "%s/skip.txt", events); unlink(path);
  rmdir(events);
  rmdir(dir);
}

static void event_filenames_missing_dir_returns_empty(void) {
  size_t count = 99;
  char **names = context_event_filenames("/tmp/zero-context-smoke-missing", &count);
  ASSERT(names == NULL, "missing events dir returns null");
  ASSERT(count == 0, "missing events dir count");
}

int main(void) {
  lifecycle_defaults_to_active_when_absent();
  lifecycle_defaults_to_active_when_state_absent();
  lifecycle_returns_stored_state();
  event_hash_excludes_event_hash();
  event_hash_is_content_addressed();
  root_payload_hash_matches_expected_payload();
  root_payload_hash_defaults_missing_fields();
  root_payload_hash_uses_legacy_nodes();
  event_filenames_are_sorted_basenames();
  event_filenames_missing_dir_returns_empty();
  printf("context smoke ok\n");
  return 0;
}
