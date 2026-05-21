#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "context.h"

#include <ctype.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static const char *context_json_skip_ws(const char *cursor) {
  while (cursor && (*cursor == ' ' || *cursor == '\n' || *cursor == '\r' || *cursor == '\t')) cursor++;
  return cursor;
}

static const char *context_json_member_value(const char *json, const char *name) {
  if (!json || !name) return NULL;
  char key[512];
  snprintf(key, sizeof(key), "\"%s\"", name);
  const char *cursor = strstr(json, key);
  if (!cursor) return NULL;
  cursor += strlen(key);
  cursor = context_json_skip_ws(cursor);
  if (!cursor || *cursor != ':') return NULL;
  return context_json_skip_ws(cursor + 1);
}

static void context_zbuf_append_len(ZBuf *buf, const char *text, size_t len) {
  for (size_t i = 0; i < len; i++) zbuf_append_char(buf, text[i]);
}

static char *context_join_path(const char *left, const char *right) {
  ZBuf buf;
  zbuf_init(&buf);
  zbuf_append(&buf, left ? left : "");
  if (buf.len > 0 && buf.data[buf.len - 1] != '/' && buf.data[buf.len - 1] != '\\') zbuf_append_char(&buf, '/');
  zbuf_append(&buf, right ? right : "");
  return buf.data;
}

static const char *context_json_skip_string_value(const char *cursor) {
  if (!cursor || *cursor != '"') return NULL;
  cursor++;
  bool escaped = false;
  while (*cursor) {
    if (escaped) escaped = false;
    else if (*cursor == '\\') escaped = true;
    else if (*cursor == '"') return cursor + 1;
    cursor++;
  }
  return NULL;
}

static char *context_json_parse_string_at(const char *cursor, const char **end_out) {
  if (!cursor || *cursor != '"') return NULL;
  cursor++;
  ZBuf value;
  zbuf_init(&value);
  while (*cursor) {
    if (*cursor == '"') {
      if (end_out) *end_out = cursor + 1;
      return value.data ? value.data : z_strdup("");
    }
    if (*cursor == '\\' && cursor[1]) {
      cursor++;
      if (*cursor == 'n') zbuf_append_char(&value, '\n');
      else if (*cursor == 'r') zbuf_append_char(&value, '\r');
      else if (*cursor == 't') zbuf_append_char(&value, '\t');
      else zbuf_append_char(&value, *cursor);
      cursor++;
      continue;
    }
    zbuf_append_char(&value, *cursor++);
  }
  zbuf_free(&value);
  return NULL;
}

static const char *context_json_value_end(const char *cursor) {
  cursor = context_json_skip_ws(cursor);
  if (!cursor || !*cursor) return NULL;
  if (*cursor == '"') return context_json_skip_string_value(cursor);
  if (*cursor == '{' || *cursor == '[') {
    char opener = *cursor;
    char closer = opener == '{' ? '}' : ']';
    int depth = 0;
    while (*cursor) {
      if (*cursor == '"') {
        cursor = context_json_skip_string_value(cursor);
        if (!cursor) return NULL;
        continue;
      }
      if (*cursor == opener) depth++;
      else if (*cursor == closer) {
        depth--;
        if (depth == 0) return cursor + 1;
      }
      cursor++;
    }
    return NULL;
  }
  while (*cursor && *cursor != ',' && *cursor != '}' && *cursor != ']' &&
         *cursor != ' ' && *cursor != '\n' && *cursor != '\r' && *cursor != '\t') cursor++;
  return cursor;
}

const char *context_storage_dir(void) {
  const char *override = getenv("ZERO_CONTEXT_DIR");
  return override && override[0] ? override : ".zero/context";
}

char *context_root_snapshot_path(const char *storage, const char *current_root) {
  if (!storage || !current_root) return NULL;
  const char *hash = strncmp(current_root, "sha256:", 7) == 0 ? current_root + 7 : current_root;
  char *roots = context_join_path(storage, "roots");
  char *file = NULL;
  if (roots) {
    ZBuf filename;
    zbuf_init(&filename);
    zbuf_append(&filename, hash);
    zbuf_append(&filename, ".json");
    file = context_join_path(roots, filename.data);
    zbuf_free(&filename);
  }
  free(roots);
  return file;
}

bool context_json_get_int(const char *json, const char *name, int *out) {
  const char *cursor = context_json_member_value(json, name);
  if (!cursor || !isdigit((unsigned char)*cursor)) return false;
  char *end = NULL;
  long value = strtol(cursor, &end, 10);
  if (!end || end == cursor) return false;
  *out = (int)value;
  return true;
}

char *context_json_get_string_or_null(const char *json, const char *name, bool *is_null) {
  if (is_null) *is_null = false;
  const char *cursor = context_json_member_value(json, name);
  if (!cursor) return NULL;
  if (strncmp(cursor, "null", 4) == 0) {
    if (is_null) *is_null = true;
    return NULL;
  }
  return context_json_parse_string_at(cursor, NULL);
}

bool context_json_emit_field(ZBuf *buf, const char *json, const char *name) {
  const char *start = context_json_member_value(json, name);
  if (!start) return false;
  const char *end = context_json_value_end(start);
  if (!end || end < start) return false;
  context_zbuf_append_len(buf, start, (size_t)(end - start));
  return true;
}

char *context_json_get_nested_string(const char *json, const char *outer, const char *inner, bool *is_null) {
  if (is_null) *is_null = false;
  const char *start = context_json_member_value(json, outer);
  if (!start || *context_json_skip_ws(start) != '{') return NULL;
  const char *end = context_json_value_end(start);
  if (!end) return NULL;
  ZBuf object;
  zbuf_init(&object);
  context_zbuf_append_len(&object, start, (size_t)(end - start));
  char *value = context_json_get_string_or_null(object.data, inner, is_null);
  zbuf_free(&object);
  return value;
}

char **context_source_index_hashes(const char *storage, const char *source_path, size_t *count) {
  if (count) *count = 0;
  if (!storage || !source_path || !count) return NULL;
  char *indexes = context_join_path(storage, "indexes");
  char *index_file = context_join_path(indexes, "source-index.json");
  ZDiag diag = {0};
  char *json = z_read_file(index_file, &diag);
  free(indexes);
  free(index_file);
  if (!json) return NULL;

  const char *sources = context_json_member_value(json, "sources");
  const char *source_hashes = sources ? context_json_member_value(sources, source_path) : NULL;
  source_hashes = context_json_skip_ws(source_hashes);
  if (!source_hashes || *source_hashes != '[') {
    free(json);
    return NULL;
  }

  size_t cap = 0;
  char **hashes = NULL;
  const char *cursor = source_hashes + 1;
  while (*cursor) {
    cursor = context_json_skip_ws(cursor);
    if (*cursor == ']') break;
    if (*cursor != '"') break;
    const char *string_end = NULL;
    char *hash = context_json_parse_string_at(cursor, &string_end);
    if (!hash) {
      break;
    }
    if (*count == cap) {
      cap = cap ? cap * 2 : 4;
      hashes = z_checked_reallocarray(hashes, cap, sizeof(char *));
    }
    hashes[(*count)++] = hash;
    cursor = context_json_skip_ws(string_end);
    if (*cursor == ',') cursor++;
  }
  free(json);
  return hashes;
}

char *context_read_node(const char *storage, const char *hash) {
  if (!storage || !hash) return NULL;
  const char *bare_hash = strncmp(hash, "sha256:", 7) == 0 ? hash + 7 : hash;
  char *nodes = context_join_path(storage, "nodes");
  ZBuf filename;
  zbuf_init(&filename);
  zbuf_append(&filename, bare_hash);
  zbuf_append(&filename, ".json");
  char *node_file = context_join_path(nodes, filename.data);
  ZDiag diag = {0};
  char *json = z_read_file(node_file, &diag);
  free(nodes);
  zbuf_free(&filename);
  free(node_file);
  return json;
}
