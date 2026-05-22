#ifndef ZERO_CONTEXT_H
#define ZERO_CONTEXT_H

#include "zero.h"

#include <stdbool.h>
#include <stddef.h>

const char *context_storage_dir(void);
char *context_root_pointer_path(const char *storage);
char *context_root_snapshot_path(const char *storage, const char *current_root);
char *context_node_path(const char *storage, const char *hash);
char *context_event_path(const char *storage, const char *event_hash);
char *context_source_index_path(const char *storage);
char **context_event_filenames(const char *storage, size_t *out_count);
char *context_event_hash(const char *event_json);
char *context_node_hash(const char *node_json);
char *context_node_lifecycle_state(const char *node_json);
char *context_root_payload_hash(const char *root_snapshot_json);

typedef struct {
  char *severity;
  char *code;
  char *message;
  char *node_id;
  char *hash;
  char *path;
  char *expected;
  char *actual;
} ContextDiagnostic;

void context_diagnostic_free(ContextDiagnostic *diagnostic);
void context_diagnostic_append(
  ZBuf *diagnostics,
  size_t *diagnostic_count,
  const char *severity,
  const char *code,
  const char *message,
  const char *node_id,
  const char *hash,
  const char *path,
  const char *expected,
  const char *actual);

typedef struct {
  char *pointer_json;
  char *current_root;
  char *current_root_snapshot_json;
  bool root_hash_ok;
  bool parent_chain_ok;
  size_t root_depth;
} ContextComplianceRootState;

typedef struct {
  size_t events;
  size_t hash_failures;
  size_t missing_roots;
  bool event_hashes_ok;
  bool root_references_ok;
} ContextComplianceTimelineState;

typedef struct {
  size_t active;
  size_t superseded;
  bool node_hashes_ok;
  bool lifecycle_ok;
  char **active_node_anchor_paths;
  char **active_node_anchor_hashes;
  size_t active_node_anchor_count;
} ContextComplianceNodeState;

void context_compliance_root_state_free(ContextComplianceRootState *state);
void context_compliance_read_root(
  const char *storage,
  ContextComplianceRootState *state,
  ZBuf *diagnostics,
  size_t *diagnostic_count);
void context_compliance_timeline_state_init(ContextComplianceTimelineState *state);
void context_compliance_read_events(
  const char *storage,
  const char *source_option,
  ContextComplianceTimelineState *state,
  ZBuf *diagnostics,
  size_t *diagnostic_count);
void context_compliance_node_state_init(ContextComplianceNodeState *state);
void context_compliance_node_state_free(ContextComplianceNodeState *state);
void context_compliance_read_nodes(
  const char *storage,
  const char *root_snapshot_json,
  ContextComplianceNodeState *state,
  ZBuf *diagnostics,
  size_t *diagnostic_count);

bool context_json_get_int(const char *json, const char *name, int *out);
char *context_json_get_string_or_null(const char *json, const char *name, bool *is_null);
bool context_json_emit_field(ZBuf *buf, const char *json, const char *name);
char *context_json_get_nested_string(const char *json, const char *outer, const char *inner, bool *is_null);
bool context_json_canonicalize(ZBuf *out, const char *json);
bool context_json_canonicalize_excluding(ZBuf *out, const char *json, const char *const *excluded_keys);

char **context_source_index_hashes(const char *storage, const char *source_path, size_t *count);
char **context_source_index_all_hashes(const char *storage, size_t *out_count);
char *context_read_node(const char *storage, const char *hash);
char *context_read_root_snapshot(const char *storage, const char *current_root);
char **context_root_active_hashes(const char *root_snapshot_json, size_t *out_count);
char **context_root_superseded_hashes(const char *root_snapshot_json, size_t *out_count);
char **context_root_all_hashes(const char *root_snapshot_json, size_t *out_count);

#endif
