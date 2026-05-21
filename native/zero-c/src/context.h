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
char **context_event_filenames(const char *storage, size_t *out_count);
char *context_event_hash(const char *event_json);
char *context_node_lifecycle_state(const char *node_json);
char *context_root_payload_hash(const char *root_snapshot_json);

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
char **context_root_all_hashes(const char *root_snapshot_json, size_t *out_count);

#endif
