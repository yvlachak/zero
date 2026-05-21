#ifndef ZERO_CONTEXT_H
#define ZERO_CONTEXT_H

#include "zero.h"

#include <stdbool.h>
#include <stddef.h>

const char *context_storage_dir(void);
char *context_root_snapshot_path(const char *storage, const char *current_root);

bool context_json_get_int(const char *json, const char *name, int *out);
char *context_json_get_string_or_null(const char *json, const char *name, bool *is_null);
bool context_json_emit_field(ZBuf *buf, const char *json, const char *name);
char *context_json_get_nested_string(const char *json, const char *outer, const char *inner, bool *is_null);

char **context_source_index_hashes(const char *storage, const char *source_path, size_t *count);
char *context_read_node(const char *storage, const char *hash);

#endif
