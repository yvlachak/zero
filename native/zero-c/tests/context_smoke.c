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

static void write_text_file(const char *path, const char *text) {
  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  ASSERT(fd >= 0, "open temp file");
  size_t len = strlen(text);
  ASSERT(write(fd, text, len) == (ssize_t)len, "write temp file");
  close(fd);
}

static void free_strings(char **items, size_t count) {
  for (size_t i = 0; i < count; i++) free(items[i]);
  free(items);
}

static char *root_snapshot_json(const char *context_root, const char *parent_root, const char *reason) {
  ZBuf json;
  zbuf_init(&json);
  zbuf_append(&json, "{\"schemaVersion\":1,\"contextRoot\":\"");
  zbuf_append(&json, context_root);
  zbuf_append(&json, "\",\"parentRoot\":");
  if (parent_root) {
    zbuf_append_char(&json, '"');
    zbuf_append(&json, parent_root);
    zbuf_append_char(&json, '"');
  } else {
    zbuf_append(&json, "null");
  }
  zbuf_append(&json, ",\"reason\":\"");
  zbuf_append(&json, reason ? reason : "manual");
  zbuf_append(&json, "\",\"activeNodes\":[],\"nodes\":[],\"supersededNodes\":[],\"archivedNodes\":[],\"createdAt\":null,\"indexes\":{\"sourceIndex\":\".zero/context/indexes/source-index.json\"}}");
  return json.data;
}

static char *valid_root_snapshot_json(const char *parent_root, char **out_hash) {
  char *draft = root_snapshot_json("sha256:placeholder", parent_root, "manual");
  char *hash = context_root_payload_hash(draft);
  free(draft);
  ASSERT(hash != NULL, "compute root payload hash");
  char *snapshot = root_snapshot_json(hash, parent_root, "manual");
  if (out_hash) *out_hash = hash;
  else free(hash);
  return snapshot;
}

static char *root_pointer_json(const char *current_root) {
  ZBuf json;
  zbuf_init(&json);
  zbuf_append(&json, "{\"schemaVersion\":1,\"currentRoot\":\"");
  zbuf_append(&json, current_root);
  zbuf_append(&json, "\",\"previousRoot\":null,\"rootPath\":\".zero/context/roots/");
  zbuf_append(&json, current_root + (strncmp(current_root, "sha256:", 7) == 0 ? 7 : 0));
  zbuf_append(&json, ".json\",\"indexes\":{\"sourceIndex\":\".zero/context/indexes/source-index.json\"}}");
  return json.data;
}

static void make_storage_dirs(const char *base, char *storage, size_t storage_len, char *roots, size_t roots_len) {
  snprintf(storage, storage_len, "%s/storage", base);
  snprintf(roots, roots_len, "%s/roots", storage);
  ASSERT(mkdir(base, 0700) == 0, "mkdir base");
  ASSERT(mkdir(storage, 0700) == 0, "mkdir storage");
  ASSERT(mkdir(roots, 0700) == 0, "mkdir roots");
}

static void cleanup_root_storage(const char *base, const char **snapshot_paths, size_t snapshot_count) {
  char path[256];
  snprintf(path, sizeof(path), "%s/storage/root.json", base);
  unlink(path);
  for (size_t i = 0; i < snapshot_count; i++) {
    if (snapshot_paths[i]) unlink(snapshot_paths[i]);
  }
  snprintf(path, sizeof(path), "%s/storage/roots", base);
  rmdir(path);
  snprintf(path, sizeof(path), "%s/storage", base);
  rmdir(path);
  rmdir(base);
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

static void compliance_root_reads_clean_single_snapshot(void) {
  char base[128], storage[160], roots[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-root1", (long)getpid());
  make_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots));
  char *root_hash = NULL;
  char *snapshot = valid_root_snapshot_json(NULL, &root_hash);
  char *pointer = root_pointer_json(root_hash);
  char *root_path = context_root_pointer_path(storage);
  char *snapshot_path = context_root_snapshot_path(storage, root_hash);
  write_text_file(root_path, pointer);
  write_text_file(snapshot_path, snapshot);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceRootState state;
  context_compliance_read_root(storage, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.pointer_json != NULL, "clean root pointer loaded");
  ASSERT(state.current_root_snapshot_json != NULL, "clean current snapshot loaded");
  ASSERT(state.root_hash_ok, "clean root hash ok");
  ASSERT(state.parent_chain_ok, "clean parent chain ok");
  ASSERT(state.root_depth == 1, "clean root depth");
  ASSERT(diagnostic_count == 0, "clean root diagnostics");

  context_compliance_root_state_free(&state);
  zbuf_free(&diagnostics);
  const char *snapshots[] = {snapshot_path};
  cleanup_root_storage(base, snapshots, 1);
  free(root_hash);
  free(snapshot);
  free(pointer);
  free(root_path);
  free(snapshot_path);
}

static void compliance_root_missing_pointer(void) {
  char base[128], storage[160], roots[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-root2", (long)getpid());
  make_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots));

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceRootState state;
  context_compliance_read_root(storage, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.pointer_json == NULL, "missing pointer state");
  ASSERT(diagnostic_count == 1, "missing pointer diagnostic count");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_ROOT_MISSING\"") != NULL, "missing pointer code");

  context_compliance_root_state_free(&state);
  zbuf_free(&diagnostics);
  cleanup_root_storage(base, NULL, 0);
}

static void compliance_root_malformed_pointer(void) {
  char base[128], storage[160], roots[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-root3", (long)getpid());
  make_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots));
  char *root_path = context_root_pointer_path(storage);
  write_text_file(root_path, "\"not json\"");

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceRootState state;
  context_compliance_read_root(storage, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.pointer_json == NULL, "malformed pointer state");
  ASSERT(diagnostic_count == 1, "malformed pointer diagnostic count");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_ROOT_POINTER_MALFORMED\"") != NULL, "malformed pointer code");

  context_compliance_root_state_free(&state);
  zbuf_free(&diagnostics);
  cleanup_root_storage(base, NULL, 0);
  free(root_path);
}

static void compliance_root_parent_chain_cycle(void) {
  char base[128], storage[160], roots[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-root4", (long)getpid());
  make_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots));
  const char *hash_a = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const char *hash_b = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  char *snapshot_a = root_snapshot_json(hash_a, hash_b, "manual");
  char *snapshot_b = root_snapshot_json(hash_b, hash_a, "manual");
  char *pointer = root_pointer_json(hash_a);
  char *root_path = context_root_pointer_path(storage);
  char *path_a = context_root_snapshot_path(storage, hash_a);
  char *path_b = context_root_snapshot_path(storage, hash_b);
  write_text_file(root_path, pointer);
  write_text_file(path_a, snapshot_a);
  write_text_file(path_b, snapshot_b);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceRootState state;
  context_compliance_read_root(storage, &state, &diagnostics, &diagnostic_count);
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_PARENT_CHAIN_BROKEN\"") != NULL, "cycle diagnostic code");
  ASSERT(strstr(diagnostics.data, hash_a) != NULL, "cycle repeated hash");
  ASSERT(!state.parent_chain_ok, "cycle parent chain false");

  context_compliance_root_state_free(&state);
  zbuf_free(&diagnostics);
  const char *snapshots[] = {path_a, path_b};
  cleanup_root_storage(base, snapshots, 2);
  free(snapshot_a);
  free(snapshot_b);
  free(pointer);
  free(root_path);
  free(path_a);
  free(path_b);
}

static void compliance_root_filename_mismatch(void) {
  char base[128], storage[160], roots[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-root5", (long)getpid());
  make_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots));
  char *root_hash = NULL;
  char *snapshot = valid_root_snapshot_json(NULL, &root_hash);
  const char *wrong_hash = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  char *pointer = root_pointer_json(wrong_hash);
  char *root_path = context_root_pointer_path(storage);
  char *snapshot_path = context_root_snapshot_path(storage, wrong_hash);
  write_text_file(root_path, pointer);
  write_text_file(snapshot_path, snapshot);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceRootState state;
  context_compliance_read_root(storage, &state, &diagnostics, &diagnostic_count);
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_FILENAME_MISMATCH\"") != NULL, "filename mismatch code");
  ASSERT(strstr(diagnostics.data, "\"expected\":\"") != NULL, "filename mismatch expected");
  ASSERT(strstr(diagnostics.data, "\"actual\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"") != NULL, "filename mismatch actual");
  ASSERT(state.root_depth >= 1, "filename mismatch nonfatal traversal");

  context_compliance_root_state_free(&state);
  zbuf_free(&diagnostics);
  const char *snapshots[] = {snapshot_path};
  cleanup_root_storage(base, snapshots, 1);
  free(root_hash);
  free(snapshot);
  free(pointer);
  free(root_path);
  free(snapshot_path);
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
  compliance_root_reads_clean_single_snapshot();
  compliance_root_missing_pointer();
  compliance_root_malformed_pointer();
  compliance_root_parent_chain_cycle();
  compliance_root_filename_mismatch();
  printf("context smoke ok\n");
  return 0;
}
