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

static char *event_json(const char *event_hash, const char *event_id, const char *source_file, const char *mode, const char *previous_root, const char *current_root) {
  ZBuf json;
  zbuf_init(&json);
  zbuf_append(&json, "{\"schemaVersion\":1,\"kind\":\"context-event\",\"eventId\":\"");
  zbuf_append(&json, event_id);
  zbuf_append(&json, "\",\"eventHash\":\"");
  zbuf_append(&json, event_hash);
  zbuf_append(&json, "\",\"mode\":\"");
  zbuf_append(&json, mode);
  zbuf_append(&json, "\",\"sourceFile\":\"");
  zbuf_append(&json, source_file);
  zbuf_append(&json, "\",\"previousRoot\":\"");
  zbuf_append(&json, previous_root);
  zbuf_append(&json, "\",\"currentRoot\":\"");
  zbuf_append(&json, current_root);
  zbuf_append(&json, "\",\"rootChanged\":true,\"captured\":[],\"skipped\":[],\"verification\":{\"ok\":true,\"checkedNodes\":0},\"diagnostics\":[]}");
  return json.data;
}

static char *valid_event_json(const char *event_id, const char *source_file, const char *mode, const char *previous_root, const char *current_root, char **out_event_hash) {
  char *draft = event_json("sha256:placeholder", event_id, source_file, mode, previous_root, current_root);
  char *hash = context_event_hash(draft);
  free(draft);
  ASSERT(hash != NULL, "compute event hash");
  char *event = event_json(hash, event_id, source_file, mode, previous_root, current_root);
  if (out_event_hash) *out_event_hash = hash;
  else free(hash);
  return event;
}

static void make_event_storage_dirs(const char *base, char *storage, size_t storage_len, char *roots, size_t roots_len, char *events, size_t events_len) {
  make_storage_dirs(base, storage, storage_len, roots, roots_len);
  snprintf(events, events_len, "%s/events", storage);
  ASSERT(mkdir(events, 0700) == 0, "mkdir events");
}

static void write_root_placeholder(const char *storage, const char *hash) {
  char *path = context_root_snapshot_path(storage, hash);
  write_text_file(path, "{}");
  free(path);
}

static void cleanup_events_storage(const char *base, const char **event_paths, size_t event_count, const char **root_paths, size_t root_count) {
  for (size_t i = 0; i < event_count; i++) {
    if (event_paths[i]) unlink(event_paths[i]);
  }
  for (size_t i = 0; i < root_count; i++) {
    if (root_paths[i]) unlink(root_paths[i]);
  }
  char path[256];
  snprintf(path, sizeof(path), "%s/storage/events", base);
  rmdir(path);
  snprintf(path, sizeof(path), "%s/storage/roots", base);
  rmdir(path);
  snprintf(path, sizeof(path), "%s/storage", base);
  rmdir(path);
  rmdir(base);
}

static void append_json_string_array(ZBuf *json, const char **items, size_t count) {
  zbuf_append_char(json, '[');
  for (size_t i = 0; i < count; i++) {
    if (i > 0) zbuf_append_char(json, ',');
    zbuf_append_char(json, '"');
    zbuf_append(json, items[i]);
    zbuf_append_char(json, '"');
  }
  zbuf_append_char(json, ']');
}

static char *node_root_snapshot_json(const char **active, size_t active_count, const char **superseded, size_t superseded_count) {
  ZBuf json;
  zbuf_init(&json);
  zbuf_append(&json, "{\"schemaVersion\":1,\"contextRoot\":\"sha256:root\",\"parentRoot\":null,\"reason\":\"manual\",\"activeNodes\":");
  append_json_string_array(&json, active, active_count);
  zbuf_append(&json, ",\"nodes\":");
  append_json_string_array(&json, active, active_count);
  zbuf_append(&json, ",\"supersededNodes\":");
  append_json_string_array(&json, superseded, superseded_count);
  zbuf_append(&json, ",\"archivedNodes\":[],\"createdAt\":null,\"indexes\":{\"sourceIndex\":\".zero/context/indexes/source-index.json\"}}");
  return json.data;
}

static char *node_json(const char *node_id, const char *hash, const char *anchor_path, const char *lifecycle_state) {
  ZBuf json;
  zbuf_init(&json);
  zbuf_append(&json, "{\"schemaVersion\":1,\"kind\":\"repair-memory\",\"nodeId\":\"");
  zbuf_append(&json, node_id);
  zbuf_append(&json, "\",\"hash\":\"");
  zbuf_append(&json, hash);
  zbuf_append(&json, "\",\"parents\":[],\"codes\":[],\"diagnosticCode\":\"TYP009\",\"repairId\":\"make-binding-mutable\",\"residualSummary\":\"test\",\"projection\":{\"kind\":\"context-projection\",\"frontier\":{\"diagnostics\":[],\"repairs\":[],\"edits\":[]}}");
  if (anchor_path) {
    zbuf_append(&json, ",\"sourceAnchor\":{\"path\":\"");
    zbuf_append(&json, anchor_path);
    zbuf_append(&json, "\",\"range\":{\"startLine\":1,\"startCol\":1,\"endLine\":1,\"endCol\":2},\"sourceHash\":null,\"status\":\"active\"}");
  }
  if (lifecycle_state) {
    zbuf_append(&json, ",\"lifecycle\":{\"state\":\"");
    zbuf_append(&json, lifecycle_state);
    zbuf_append(&json, "\",\"supersedes\":[],\"supersededBy\":null}");
  }
  zbuf_append_char(&json, '}');
  return json.data;
}

static char *valid_node_json(const char *node_id, const char *anchor_path, const char *lifecycle_state, char **out_node_hash) {
  char *draft = node_json(node_id, "sha256:placeholder", anchor_path, lifecycle_state);
  char *hash = context_node_hash(draft);
  free(draft);
  ASSERT(hash != NULL, "compute node hash");
  char *node = node_json(node_id, hash, anchor_path, lifecycle_state);
  if (out_node_hash) *out_node_hash = hash;
  else free(hash);
  return node;
}

static char *anchor_node_json(
  const char *node_id,
  const char *hash,
  const char *anchor_path,
  const char *source_hash,
  int start_line,
  int start_col,
  int end_line,
  int end_col,
  const char *precondition,
  const char *lifecycle_state) {
  ZBuf json;
  zbuf_init(&json);
  zbuf_append(&json, "{\"schemaVersion\":1,\"kind\":\"repair-memory\",\"nodeId\":\"");
  zbuf_append(&json, node_id);
  zbuf_append(&json, "\",\"hash\":\"");
  zbuf_append(&json, hash);
  zbuf_append(&json, "\",\"parents\":[],\"codes\":[],\"diagnosticCode\":\"TYP009\",\"repairId\":\"make-binding-mutable\",\"residualSummary\":\"test\",\"projection\":{\"kind\":\"context-projection\",\"frontier\":{\"diagnostics\":[],\"repairs\":[],\"edits\":");
  if (precondition) {
    zbuf_append(&json, "[{\"path\":\"");
    zbuf_append(&json, anchor_path);
    zbuf_append(&json, "\",\"precondition\":{\"kind\":\"exact-text\",\"text\":\"");
    zbuf_append(&json, precondition);
    zbuf_append(&json, "\"},\"replacement\":\"\"}]");
  } else {
    zbuf_append(&json, "[]");
  }
  zbuf_append(&json, "}},\"sourceAnchor\":{\"path\":\"");
  zbuf_append(&json, anchor_path);
  zbuf_append(&json, "\",\"range\":{\"startLine\":");
  zbuf_appendf(&json, "%d", start_line);
  zbuf_append(&json, ",\"startCol\":");
  zbuf_appendf(&json, "%d", start_col);
  zbuf_append(&json, ",\"endLine\":");
  zbuf_appendf(&json, "%d", end_line);
  zbuf_append(&json, ",\"endCol\":");
  zbuf_appendf(&json, "%d", end_col);
  zbuf_append(&json, "},\"sourceHash\":");
  if (source_hash) {
    zbuf_append_char(&json, '"');
    zbuf_append(&json, source_hash);
    zbuf_append_char(&json, '"');
  } else {
    zbuf_append(&json, "null");
  }
  zbuf_append(&json, ",\"status\":\"active\"}");
  if (lifecycle_state) {
    zbuf_append(&json, ",\"lifecycle\":{\"state\":\"");
    zbuf_append(&json, lifecycle_state);
    zbuf_append(&json, "\",\"supersedes\":[],\"supersededBy\":null}");
  }
  zbuf_append_char(&json, '}');
  return json.data;
}

static char *valid_anchor_node_json(
  const char *node_id,
  const char *anchor_path,
  const char *source_hash,
  int start_line,
  int start_col,
  int end_line,
  int end_col,
  const char *precondition,
  char **out_node_hash) {
  char *draft = anchor_node_json(node_id, "sha256:placeholder", anchor_path, source_hash, start_line, start_col, end_line, end_col, precondition, "active");
  char *hash = context_node_hash(draft);
  free(draft);
  ASSERT(hash != NULL, "compute anchor node hash");
  char *node = anchor_node_json(node_id, hash, anchor_path, source_hash, start_line, start_col, end_line, end_col, precondition, "active");
  if (out_node_hash) *out_node_hash = hash;
  else free(hash);
  return node;
}

static void make_node_storage_dirs(const char *base, char *storage, size_t storage_len, char *nodes, size_t nodes_len) {
  snprintf(storage, storage_len, "%s/storage", base);
  snprintf(nodes, nodes_len, "%s/nodes", storage);
  ASSERT(mkdir(base, 0700) == 0, "mkdir node base");
  ASSERT(mkdir(storage, 0700) == 0, "mkdir node storage");
  ASSERT(mkdir(nodes, 0700) == 0, "mkdir nodes");
}

static char *write_node_at(const char *storage, const char *hash, const char *content) {
  char *path = context_node_path(storage, hash);
  write_text_file(path, content);
  return path;
}

static void cleanup_node_storage(const char *base, const char **node_paths, size_t node_count) {
  for (size_t i = 0; i < node_count; i++) {
    if (node_paths[i]) unlink(node_paths[i]);
  }
  char path[256];
  snprintf(path, sizeof(path), "%s/storage/nodes", base);
  rmdir(path);
  snprintf(path, sizeof(path), "%s/storage", base);
  rmdir(path);
  rmdir(base);
}

static void make_index_storage_dirs(const char *base, char *storage, size_t storage_len, char *nodes, size_t nodes_len, char *indexes, size_t indexes_len) {
  make_node_storage_dirs(base, storage, storage_len, nodes, nodes_len);
  snprintf(indexes, indexes_len, "%s/indexes", storage);
  ASSERT(mkdir(indexes, 0700) == 0, "mkdir indexes");
}

static void write_source_index_json(const char *storage, const char *json) {
  char *path = context_source_index_path(storage);
  write_text_file(path, json);
  free(path);
}

static void cleanup_index_storage(const char *base, const char **node_paths, size_t node_count) {
  char path[256];
  snprintf(path, sizeof(path), "%s/storage/indexes/source-index.json", base);
  unlink(path);
  snprintf(path, sizeof(path), "%s/storage/indexes", base);
  rmdir(path);
  cleanup_node_storage(base, node_paths, node_count);
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

static void compliance_events_clean_no_diagnostics(void) {
  char base[128], storage[160], roots[192], events[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-events1", (long)getpid());
  make_event_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots), events, sizeof(events));
  const char *previous_root = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const char *current_root = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  write_root_placeholder(storage, previous_root);
  write_root_placeholder(storage, current_root);
  char *event_hash_a = NULL;
  char *event_hash_b = NULL;
  char *event_a_json = valid_event_json("ctx:event:000001", "source.0", "context-check-cycle", previous_root, current_root, &event_hash_a);
  char *event_b_json = valid_event_json("ctx:event:000002", "source.0", "context-reconcile", previous_root, current_root, &event_hash_b);
  char *event_path_a = context_event_path(storage, event_hash_a);
  char *event_path_b = context_event_path(storage, event_hash_b);
  write_text_file(event_path_a, event_a_json);
  write_text_file(event_path_b, event_b_json);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceTimelineState state;
  context_compliance_read_events(storage, NULL, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.events == 2, "clean event count");
  ASSERT(state.event_hashes_ok, "clean event hashes ok");
  ASSERT(state.root_references_ok, "clean event roots ok");
  ASSERT(diagnostic_count == 0, "clean event diagnostics");

  zbuf_free(&diagnostics);
  char *previous_path = context_root_snapshot_path(storage, previous_root);
  char *current_path = context_root_snapshot_path(storage, current_root);
  const char *event_paths[] = {event_path_a, event_path_b};
  const char *root_paths[] = {previous_path, current_path};
  cleanup_events_storage(base, event_paths, 2, root_paths, 2);
  free(previous_path);
  free(current_path);
  free(event_hash_a);
  free(event_hash_b);
  free(event_a_json);
  free(event_b_json);
  free(event_path_a);
  free(event_path_b);
}

static void compliance_events_malformed_json(void) {
  char base[128], storage[160], roots[192], events[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-events2", (long)getpid());
  make_event_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots), events, sizeof(events));
  const char *bad_hash = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
  char *event_path = context_event_path(storage, bad_hash);
  write_text_file(event_path, "not json");

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceTimelineState state;
  context_compliance_read_events(storage, NULL, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.events == 0, "malformed json event not counted");
  ASSERT(diagnostic_count == 1, "malformed json diagnostic count");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_EVENT_MALFORMED\"") != NULL, "malformed json diagnostic code");
  ASSERT(strstr(diagnostics.data, "context event is not valid JSON") != NULL, "malformed json message");

  zbuf_free(&diagnostics);
  const char *event_paths[] = {event_path};
  cleanup_events_storage(base, event_paths, 1, NULL, 0);
  free(event_path);
}

static void compliance_events_malformed_schema(void) {
  char base[128], storage[160], roots[192], events[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-events3", (long)getpid());
  make_event_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots), events, sizeof(events));
  const char *bad_hash = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
  char *event_path = context_event_path(storage, bad_hash);
  write_text_file(event_path, "{\"schemaVersion\":1,\"eventHash\":\"sha256:4444444444444444444444444444444444444444444444444444444444444444\"}");

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceTimelineState state;
  context_compliance_read_events(storage, NULL, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.events == 0, "malformed schema event not counted");
  ASSERT(diagnostic_count == 1, "malformed schema diagnostic count");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_EVENT_MALFORMED\"") != NULL, "malformed schema diagnostic code");
  ASSERT(strstr(diagnostics.data, "context event has an unsupported schema") != NULL, "malformed schema message");

  zbuf_free(&diagnostics);
  const char *event_paths[] = {event_path};
  cleanup_events_storage(base, event_paths, 1, NULL, 0);
  free(event_path);
}

static void compliance_events_hash_mismatch(void) {
  char base[128], storage[160], roots[192], events[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-events4", (long)getpid());
  make_event_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots), events, sizeof(events));
  const char *previous_root = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
  const char *current_root = "sha256:6666666666666666666666666666666666666666666666666666666666666666";
  write_root_placeholder(storage, previous_root);
  write_root_placeholder(storage, current_root);
  const char *wrong_hash = "sha256:7777777777777777777777777777777777777777777777777777777777777777";
  char *event = event_json(wrong_hash, "ctx:event:000001", "source.0", "context-check-cycle", previous_root, current_root);
  char *event_path = context_event_path(storage, wrong_hash);
  write_text_file(event_path, event);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceTimelineState state;
  context_compliance_read_events(storage, NULL, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.events == 1, "hash mismatch event counted");
  ASSERT(!state.event_hashes_ok, "hash mismatch event hashes false");
  ASSERT(state.hash_failures == 1, "hash mismatch count");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_EVENT_HASH_MISMATCH\"") != NULL, "hash mismatch diagnostic code");

  zbuf_free(&diagnostics);
  char *previous_path = context_root_snapshot_path(storage, previous_root);
  char *current_path = context_root_snapshot_path(storage, current_root);
  const char *event_paths[] = {event_path};
  const char *root_paths[] = {previous_path, current_path};
  cleanup_events_storage(base, event_paths, 1, root_paths, 2);
  free(previous_path);
  free(current_path);
  free(event);
  free(event_path);
}

static void compliance_events_root_missing(void) {
  char base[128], storage[160], roots[192], events[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-events5", (long)getpid());
  make_event_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots), events, sizeof(events));
  const char *missing_root = "sha256:8888888888888888888888888888888888888888888888888888888888888888";
  const char *current_root = "sha256:9999999999999999999999999999999999999999999999999999999999999999";
  write_root_placeholder(storage, current_root);
  char *event_hash = NULL;
  char *event = valid_event_json("ctx:event:000001", "source.0", "context-check-cycle", missing_root, current_root, &event_hash);
  char *event_path = context_event_path(storage, event_hash);
  write_text_file(event_path, event);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceTimelineState state;
  context_compliance_read_events(storage, NULL, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.events == 1, "missing root event counted");
  ASSERT(!state.root_references_ok, "missing root references false");
  ASSERT(state.missing_roots == 1, "missing root count");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_EVENT_ROOT_MISSING\"") != NULL, "missing root diagnostic code");
  ASSERT(strstr(diagnostics.data, missing_root) != NULL, "missing root hash");

  zbuf_free(&diagnostics);
  char *current_path = context_root_snapshot_path(storage, current_root);
  const char *event_paths[] = {event_path};
  const char *root_paths[] = {current_path};
  cleanup_events_storage(base, event_paths, 1, root_paths, 1);
  free(current_path);
  free(event_hash);
  free(event);
  free(event_path);
}

static void compliance_events_filename_mismatch(void) {
  char base[128], storage[160], roots[192], events[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-events6", (long)getpid());
  make_event_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots), events, sizeof(events));
  const char *previous_root = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
  const char *current_root = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
  const char *wrong_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3";
  write_root_placeholder(storage, previous_root);
  write_root_placeholder(storage, current_root);
  char *event_hash = NULL;
  char *event = valid_event_json("ctx:event:000001", "source.0", "context-check-cycle", previous_root, current_root, &event_hash);
  char *event_path = context_event_path(storage, wrong_hash);
  write_text_file(event_path, event);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceTimelineState state;
  context_compliance_read_events(storage, NULL, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.events == 1, "filename mismatch event counted");
  ASSERT(state.event_hashes_ok, "filename mismatch hash still ok");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_FILENAME_MISMATCH\"") != NULL, "event filename mismatch code");
  ASSERT(strstr(diagnostics.data, "event filename does not match its eventHash field") != NULL, "event filename mismatch message");

  zbuf_free(&diagnostics);
  char *previous_path = context_root_snapshot_path(storage, previous_root);
  char *current_path = context_root_snapshot_path(storage, current_root);
  const char *event_paths[] = {event_path};
  const char *root_paths[] = {previous_path, current_path};
  cleanup_events_storage(base, event_paths, 1, root_paths, 2);
  free(previous_path);
  free(current_path);
  free(event_hash);
  free(event);
  free(event_path);
}

static void compliance_events_source_filter(void) {
  char base[128], storage[160], roots[192], events[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-events7", (long)getpid());
  make_event_storage_dirs(base, storage, sizeof(storage), roots, sizeof(roots), events, sizeof(events));
  const char *previous_root = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1";
  const char *current_root = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
  const char *missing_root = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb3";
  write_root_placeholder(storage, previous_root);
  write_root_placeholder(storage, current_root);
  char *event_hash_a = NULL;
  char *event_hash_b = NULL;
  char *event_a_json = valid_event_json("ctx:event:000001", "kept.0", "context-check-cycle", previous_root, current_root, &event_hash_a);
  char *event_b_json = valid_event_json("ctx:event:000002", "skipped.0", "context-check-cycle", missing_root, missing_root, &event_hash_b);
  char *event_path_a = context_event_path(storage, event_hash_a);
  char *event_path_b = context_event_path(storage, event_hash_b);
  write_text_file(event_path_a, event_a_json);
  write_text_file(event_path_b, event_b_json);

  ZBuf diagnostics;
  zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceTimelineState state;
  context_compliance_read_events(storage, "kept.0", &state, &diagnostics, &diagnostic_count);
  ASSERT(state.events == 1, "source filter event count");
  ASSERT(diagnostic_count == 0, "source filter diagnostics");

  zbuf_free(&diagnostics);
  char *previous_path = context_root_snapshot_path(storage, previous_root);
  char *current_path = context_root_snapshot_path(storage, current_root);
  const char *event_paths[] = {event_path_a, event_path_b};
  const char *root_paths[] = {previous_path, current_path};
  cleanup_events_storage(base, event_paths, 2, root_paths, 2);
  free(previous_path);
  free(current_path);
  free(event_hash_a);
  free(event_hash_b);
  free(event_a_json);
  free(event_b_json);
  free(event_path_a);
  free(event_path_b);
}

static void compliance_nodes_clean(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes1", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  char *active_hash_a = NULL, *active_hash_b = NULL, *superseded_hash = NULL;
  char *active_a = valid_node_json("ctx:node:active-a", "a.0", "active", &active_hash_a);
  char *active_b = valid_node_json("ctx:node:active-b", "b.0", "active", &active_hash_b);
  char *superseded = valid_node_json("ctx:node:superseded", NULL, "superseded", &superseded_hash);
  char *path_a = write_node_at(storage, active_hash_a, active_a);
  char *path_b = write_node_at(storage, active_hash_b, active_b);
  char *path_s = write_node_at(storage, superseded_hash, superseded);
  const char *active_hashes[] = {active_hash_a, active_hash_b};
  const char *superseded_hashes[] = {superseded_hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 2, superseded_hashes, 1);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.active == 2, "clean active node count");
  ASSERT(state.superseded == 1, "clean superseded node count");
  ASSERT(state.node_hashes_ok, "clean node hashes ok");
  ASSERT(state.lifecycle_ok, "clean lifecycle ok");
  ASSERT(state.active_node_anchor_count == 2, "clean anchor pair count");
  ASSERT(diagnostic_count == 0, "clean node diagnostics");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path_a, path_b, path_s};
  cleanup_node_storage(base, paths, 3);
  free(active_hash_a); free(active_hash_b); free(superseded_hash);
  free(active_a); free(active_b); free(superseded); free(snapshot);
  free(path_a); free(path_b); free(path_s);
}

static void compliance_nodes_active_missing(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes2", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  const char *missing = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const char *active_hashes[] = {missing};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.active == 0, "missing active not counted");
  ASSERT(!state.node_hashes_ok, "missing active hashes false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_NODE_MISSING\"") != NULL, "missing active diagnostic");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  cleanup_node_storage(base, NULL, 0);
  free(snapshot);
}

static void compliance_nodes_malformed(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes3", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  const char *hash = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  char *path = write_node_at(storage, hash, "not json");
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.active == 0, "malformed active not counted");
  ASSERT(!state.node_hashes_ok, "malformed node hashes false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_NODE_MALFORMED\"") != NULL, "malformed node diagnostic");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(path); free(snapshot);
}

static void compliance_nodes_hash_mismatch(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes4", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  const char *wrong_hash = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  char *node = node_json("ctx:node:hash-mismatch", wrong_hash, NULL, "active");
  char *path = write_node_at(storage, wrong_hash, node);
  const char *active_hashes[] = {wrong_hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.active == 1, "hash mismatch active counted");
  ASSERT(!state.node_hashes_ok, "hash mismatch hashes false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_NODE_HASH_MISMATCH\"") != NULL, "hash mismatch diagnostic");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(node); free(path); free(snapshot);
}

static void compliance_nodes_active_superseded(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes5", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  char *hash = NULL;
  char *node = valid_node_json("ctx:node:active-superseded", NULL, "superseded", &hash);
  char *path = write_node_at(storage, hash, node);
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(!state.lifecycle_ok, "active superseded lifecycle false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_ACTIVE_NODE_SUPERSEDED\"") != NULL, "active superseded diagnostic");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_nodes_lifecycle_missing(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes6", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  char *hash = NULL;
  char *node = valid_node_json("ctx:node:lifecycle-missing", NULL, NULL, &hash);
  char *path = write_node_at(storage, hash, node);
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.active == 1, "missing lifecycle active counted");
  ASSERT(state.lifecycle_ok, "missing lifecycle warning keeps lifecycle ok");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_NODE_LIFECYCLE_MISSING\"") != NULL, "missing lifecycle diagnostic");
  ASSERT(strstr(diagnostics.data, "\"severity\":\"warning\"") != NULL, "missing lifecycle warning");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_nodes_filename_mismatch(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes7", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  char *hash = NULL;
  char *node = valid_node_json("ctx:node:filename-mismatch", NULL, "active", &hash);
  const char *wrong_hash = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  char *path = write_node_at(storage, wrong_hash, node);
  const char *active_hashes[] = {wrong_hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_FILENAME_MISMATCH\"") != NULL, "node filename mismatch diagnostic");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_NODE_HASH_MISMATCH\"") != NULL, "node filename hash mismatch diagnostic");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_nodes_superseded_active(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes8", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  char *hash = NULL;
  char *node = valid_node_json("ctx:node:superseded-active", NULL, "active", &hash);
  char *path = write_node_at(storage, hash, node);
  const char *superseded_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(NULL, 0, superseded_hashes, 1);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.superseded == 1, "superseded active counted");
  ASSERT(!state.lifecycle_ok, "superseded active lifecycle false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_SUPERSEDED_NODE_ACTIVE\"") != NULL, "superseded active diagnostic");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_nodes_superseded_missing(void) {
  char base[128], storage[160], nodes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-nodes9", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes, sizeof(nodes));
  const char *missing = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const char *superseded_hashes[] = {missing};
  char *snapshot = node_root_snapshot_json(NULL, 0, superseded_hashes, 1);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState state;
  context_compliance_read_nodes(storage, snapshot, &state, &diagnostics, &diagnostic_count);
  ASSERT(state.superseded == 0, "missing superseded not counted");
  ASSERT(!state.lifecycle_ok, "missing superseded lifecycle false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_SUPERSEDED_NODE_MISSING\"") != NULL, "missing superseded diagnostic");
  context_compliance_node_state_free(&state);
  zbuf_free(&diagnostics);
  cleanup_node_storage(base, NULL, 0);
  free(snapshot);
}

static void compliance_anchors_clean(void) {
  char base[128], storage[160], nodes_dir[192], source_path[224];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-anchor1", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir));
  snprintf(source_path, sizeof(source_path), "%s/source.0", base);
  write_text_file(source_path, "let value\n");
  char *source_hash = context_source_file_hash(source_path);
  char *hash = NULL;
  char *node = valid_anchor_node_json("ctx:node:anchor-clean", source_path, source_hash, 1, 1, 1, 4, "let", &hash);
  char *path = write_node_at(storage, hash, node);
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState node_state;
  context_compliance_read_nodes(storage, snapshot, &node_state, &diagnostics, &diagnostic_count);
  ContextComplianceAnchorState anchor_state;
  context_compliance_read_anchors(storage, NULL, &node_state, &anchor_state, &diagnostics, &diagnostic_count);
  ASSERT(anchor_state.checked == 1, "clean anchor checked count");
  ASSERT(anchor_state.ok, "clean anchor ok");
  ASSERT(diagnostic_count == 0, "clean anchor diagnostics");
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  unlink(source_path);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(source_hash); free(hash); free(node); free(path); free(snapshot);
}

static void compliance_anchors_source_missing(void) {
  char base[128], storage[160], nodes_dir[192], source_path[224];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-anchor2", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir));
  snprintf(source_path, sizeof(source_path), "%s/missing.0", base);
  char *hash = NULL;
  char *node = valid_anchor_node_json("ctx:node:anchor-missing", source_path, NULL, 1, 1, 1, 4, "let", &hash);
  char *path = write_node_at(storage, hash, node);
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState node_state;
  context_compliance_read_nodes(storage, snapshot, &node_state, &diagnostics, &diagnostic_count);
  ContextComplianceAnchorState anchor_state;
  context_compliance_read_anchors(storage, NULL, &node_state, &anchor_state, &diagnostics, &diagnostic_count);
  ASSERT(anchor_state.checked == 1, "missing source anchor checked count");
  ASSERT(!anchor_state.ok, "missing source anchor false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_SOURCE_MISSING\"") != NULL, "missing source diagnostic");
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_anchors_hash_mismatch(void) {
  char base[128], storage[160], nodes_dir[192], source_path[224];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-anchor3", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir));
  snprintf(source_path, sizeof(source_path), "%s/source.0", base);
  write_text_file(source_path, "let value\n");
  const char *wrong_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  char *hash = NULL;
  char *node = valid_anchor_node_json("ctx:node:anchor-hash", source_path, wrong_hash, 1, 1, 1, 4, "let", &hash);
  char *path = write_node_at(storage, hash, node);
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState node_state;
  context_compliance_read_nodes(storage, snapshot, &node_state, &diagnostics, &diagnostic_count);
  ContextComplianceAnchorState anchor_state;
  context_compliance_read_anchors(storage, NULL, &node_state, &anchor_state, &diagnostics, &diagnostic_count);
  ASSERT(!anchor_state.ok, "source hash mismatch anchor false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_SOURCE_HASH_MISMATCH\"") != NULL, "source hash mismatch diagnostic");
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  unlink(source_path);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_anchors_range_invalid(void) {
  char base[128], storage[160], nodes_dir[192], source_path[224];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-anchor4", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir));
  snprintf(source_path, sizeof(source_path), "%s/source.0", base);
  write_text_file(source_path, "let value\n");
  char *source_hash = context_source_file_hash(source_path);
  char *hash = NULL;
  char *node = valid_anchor_node_json("ctx:node:anchor-range", source_path, source_hash, 999, 1, 999, 2, "let", &hash);
  char *path = write_node_at(storage, hash, node);
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState node_state;
  context_compliance_read_nodes(storage, snapshot, &node_state, &diagnostics, &diagnostic_count);
  ContextComplianceAnchorState anchor_state;
  context_compliance_read_anchors(storage, NULL, &node_state, &anchor_state, &diagnostics, &diagnostic_count);
  ASSERT(!anchor_state.ok, "range invalid anchor false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_ANCHOR_RANGE_INVALID\"") != NULL, "range invalid diagnostic");
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  unlink(source_path);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(source_hash); free(hash); free(node); free(path); free(snapshot);
}

static void compliance_anchors_precondition_mismatch(void) {
  char base[128], storage[160], nodes_dir[192], source_path[224];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-anchor5", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir));
  snprintf(source_path, sizeof(source_path), "%s/source.0", base);
  write_text_file(source_path, "let value\n");
  char *source_hash = context_source_file_hash(source_path);
  char *hash = NULL;
  char *node = valid_anchor_node_json("ctx:node:anchor-precondition", source_path, source_hash, 1, 1, 1, 4, "var", &hash);
  char *path = write_node_at(storage, hash, node);
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState node_state;
  context_compliance_read_nodes(storage, snapshot, &node_state, &diagnostics, &diagnostic_count);
  ContextComplianceAnchorState anchor_state;
  context_compliance_read_anchors(storage, NULL, &node_state, &anchor_state, &diagnostics, &diagnostic_count);
  ASSERT(!anchor_state.ok, "precondition mismatch anchor false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_PRECONDITION_MISMATCH\"") != NULL, "precondition mismatch diagnostic");
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  unlink(source_path);
  const char *paths[] = {path};
  cleanup_node_storage(base, paths, 1);
  free(source_hash); free(hash); free(node); free(path); free(snapshot);
}

static void compliance_anchors_source_filter(void) {
  char base[128], storage[160], nodes_dir[192], source_a[224], source_b[224];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-anchor6", (long)getpid());
  make_node_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir));
  snprintf(source_a, sizeof(source_a), "%s/a.0", base);
  snprintf(source_b, sizeof(source_b), "%s/b.0", base);
  write_text_file(source_a, "let a\n");
  char *source_hash = context_source_file_hash(source_a);
  char *hash_a = NULL, *hash_b = NULL;
  char *node_a = valid_anchor_node_json("ctx:node:anchor-filter-a", source_a, source_hash, 1, 1, 1, 4, "let", &hash_a);
  char *node_b = valid_anchor_node_json("ctx:node:anchor-filter-b", source_b, NULL, 1, 1, 1, 4, "let", &hash_b);
  char *path_a = write_node_at(storage, hash_a, node_a);
  char *path_b = write_node_at(storage, hash_b, node_b);
  const char *active_hashes[] = {hash_a, hash_b};
  char *snapshot = node_root_snapshot_json(active_hashes, 2, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState node_state;
  context_compliance_read_nodes(storage, snapshot, &node_state, &diagnostics, &diagnostic_count);
  ContextComplianceAnchorState anchor_state;
  context_compliance_read_anchors(storage, source_a, &node_state, &anchor_state, &diagnostics, &diagnostic_count);
  ASSERT(anchor_state.checked == 1, "anchor source filter checked one");
  ASSERT(anchor_state.ok, "anchor source filter ok");
  ASSERT(diagnostic_count == 0, "anchor source filter diagnostics");
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  unlink(source_a);
  const char *paths[] = {path_a, path_b};
  cleanup_node_storage(base, paths, 2);
  free(source_hash); free(hash_a); free(hash_b); free(node_a); free(node_b); free(path_a); free(path_b); free(snapshot);
}

static void compliance_source_index_points_to_superseded(void) {
  char base[128], storage[160], nodes_dir[192], indexes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-index1", (long)getpid());
  make_index_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir), indexes, sizeof(indexes));
  char *hash = NULL;
  char *node = valid_node_json("ctx:node:index-superseded", NULL, "superseded", &hash);
  char *path = write_node_at(storage, hash, node);
  ZBuf index_json; zbuf_init(&index_json);
  zbuf_append(&index_json, "{\"schemaVersion\":1,\"sources\":{\"source.0\":[\"");
  zbuf_append(&index_json, hash);
  zbuf_append(&index_json, "\"]}}");
  write_source_index_json(storage, index_json.data);
  const char *superseded_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(NULL, 0, superseded_hashes, 1);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextSourceIndexState index_state;
  context_compliance_read_source_index(storage, &index_state, &diagnostics, &diagnostic_count);
  bool source_index_ok = index_state.exists && !index_state.malformed;
  ContextComplianceNodeState node_state;
  context_compliance_node_state_init(&node_state);
  context_compliance_check_source_index_traversal(&index_state, storage, snapshot, NULL, &node_state, &source_index_ok, &diagnostics, &diagnostic_count);
  ASSERT(!source_index_ok, "superseded index false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_SOURCE_INDEX_POINTS_TO_SUPERSEDED\"") != NULL, "superseded index diagnostic");
  context_source_index_state_free(&index_state);
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  zbuf_free(&index_json);
  const char *paths[] = {path};
  cleanup_index_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_source_index_stale_orphan(void) {
  char base[128], storage[160], nodes_dir[192], indexes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-index2", (long)getpid());
  make_index_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir), indexes, sizeof(indexes));
  const char *orphan = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9";
  ZBuf index_json; zbuf_init(&index_json);
  zbuf_append(&index_json, "{\"schemaVersion\":1,\"sources\":{\"source.0\":[\"");
  zbuf_append(&index_json, orphan);
  zbuf_append(&index_json, "\"]}}");
  write_source_index_json(storage, index_json.data);
  char *snapshot = node_root_snapshot_json(NULL, 0, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextSourceIndexState index_state;
  context_compliance_read_source_index(storage, &index_state, &diagnostics, &diagnostic_count);
  bool source_index_ok = index_state.exists && !index_state.malformed;
  ContextComplianceNodeState node_state;
  context_compliance_node_state_init(&node_state);
  context_compliance_check_source_index_traversal(&index_state, storage, snapshot, NULL, &node_state, &source_index_ok, &diagnostics, &diagnostic_count);
  ASSERT(!source_index_ok, "orphan index false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_SOURCE_INDEX_STALE\"") != NULL, "orphan index diagnostic");
  ASSERT(strstr(diagnostics.data, "missing or inactive") != NULL, "orphan index message");
  context_source_index_state_free(&index_state);
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  zbuf_free(&index_json);
  cleanup_index_storage(base, NULL, 0);
  free(snapshot);
}

static void compliance_source_index_stale_reverse(void) {
  char base[128], storage[160], nodes_dir[192], indexes[192], source_path[224];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-index3", (long)getpid());
  make_index_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir), indexes, sizeof(indexes));
  snprintf(source_path, sizeof(source_path), "%s/source.0", base);
  char *hash = NULL;
  char *node = valid_anchor_node_json("ctx:node:index-reverse", source_path, NULL, 1, 1, 1, 2, NULL, &hash);
  char *path = write_node_at(storage, hash, node);
  write_source_index_json(storage, "{\"schemaVersion\":1,\"sources\":{}}");
  const char *active_hashes[] = {hash};
  char *snapshot = node_root_snapshot_json(active_hashes, 1, NULL, 0);
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextComplianceNodeState node_state;
  context_compliance_read_nodes(storage, snapshot, &node_state, &diagnostics, &diagnostic_count);
  ContextSourceIndexState index_state;
  context_compliance_read_source_index(storage, &index_state, &diagnostics, &diagnostic_count);
  bool source_index_ok = index_state.exists && !index_state.malformed;
  context_compliance_check_source_index_traversal(&index_state, storage, snapshot, NULL, &node_state, &source_index_ok, &diagnostics, &diagnostic_count);
  ASSERT(!source_index_ok, "reverse index false");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_SOURCE_INDEX_STALE\"") != NULL, "reverse index diagnostic");
  ASSERT(strstr(diagnostics.data, "missing an active context node") != NULL, "reverse index message");
  context_source_index_state_free(&index_state);
  context_compliance_node_state_free(&node_state);
  zbuf_free(&diagnostics);
  const char *paths[] = {path};
  cleanup_index_storage(base, paths, 1);
  free(hash); free(node); free(path); free(snapshot);
}

static void compliance_source_index_malformed(void) {
  char base[128], storage[160], nodes_dir[192], indexes[192];
  snprintf(base, sizeof(base), "/tmp/zero-context-smoke-%ld-index4", (long)getpid());
  make_index_storage_dirs(base, storage, sizeof(storage), nodes_dir, sizeof(nodes_dir), indexes, sizeof(indexes));
  write_source_index_json(storage, "not json");
  ZBuf diagnostics; zbuf_init(&diagnostics);
  size_t diagnostic_count = 0;
  ContextSourceIndexState index_state;
  context_compliance_read_source_index(storage, &index_state, &diagnostics, &diagnostic_count);
  ASSERT(index_state.exists, "malformed index exists");
  ASSERT(index_state.malformed, "malformed index state");
  ASSERT(strstr(diagnostics.data, "\"code\":\"CTX_COMPLIANCE_SOURCE_INDEX_MALFORMED\"") != NULL, "malformed index diagnostic");
  ASSERT(strstr(diagnostics.data, "CTX_COMPLIANCE_SOURCE_INDEX_MISSING") == NULL, "malformed index not missing");
  context_source_index_state_free(&index_state);
  zbuf_free(&diagnostics);
  cleanup_index_storage(base, NULL, 0);
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
  compliance_events_clean_no_diagnostics();
  compliance_events_malformed_json();
  compliance_events_malformed_schema();
  compliance_events_hash_mismatch();
  compliance_events_root_missing();
  compliance_events_filename_mismatch();
  compliance_events_source_filter();
  compliance_nodes_clean();
  compliance_nodes_active_missing();
  compliance_nodes_malformed();
  compliance_nodes_hash_mismatch();
  compliance_nodes_active_superseded();
  compliance_nodes_lifecycle_missing();
  compliance_nodes_filename_mismatch();
  compliance_nodes_superseded_active();
  compliance_nodes_superseded_missing();
  compliance_anchors_clean();
  compliance_anchors_source_missing();
  compliance_anchors_hash_mismatch();
  compliance_anchors_range_invalid();
  compliance_anchors_precondition_mismatch();
  compliance_anchors_source_filter();
  compliance_source_index_points_to_superseded();
  compliance_source_index_stale_orphan();
  compliance_source_index_stale_reverse();
  compliance_source_index_malformed();
  printf("context smoke ok\n");
  return 0;
}
