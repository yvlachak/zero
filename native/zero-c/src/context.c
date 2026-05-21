#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "context.h"
#include "hash.h"

#include <ctype.h>
#include <dirent.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

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

static void context_zbuf_append_utf8(ZBuf *buf, unsigned codepoint) {
  if (codepoint <= 0x7fu) {
    zbuf_append_char(buf, (char)codepoint);
  } else if (codepoint <= 0x7ffu) {
    zbuf_append_char(buf, (char)(0xc0u | (codepoint >> 6)));
    zbuf_append_char(buf, (char)(0x80u | (codepoint & 0x3fu)));
  } else {
    zbuf_append_char(buf, (char)(0xe0u | (codepoint >> 12)));
    zbuf_append_char(buf, (char)(0x80u | ((codepoint >> 6) & 0x3fu)));
    zbuf_append_char(buf, (char)(0x80u | (codepoint & 0x3fu)));
  }
}

static int context_hex_value(char ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return 10 + ch - 'a';
  if (ch >= 'A' && ch <= 'F') return 10 + ch - 'A';
  return -1;
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
      else if (*cursor == 'b') zbuf_append_char(&value, '\b');
      else if (*cursor == 'f') zbuf_append_char(&value, '\f');
      else if (*cursor == 'u') {
        int h0 = context_hex_value(cursor[1]);
        int h1 = context_hex_value(cursor[2]);
        int h2 = context_hex_value(cursor[3]);
        int h3 = context_hex_value(cursor[4]);
        if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) {
          zbuf_free(&value);
          return NULL;
        }
        unsigned codepoint = (unsigned)((h0 << 12) | (h1 << 8) | (h2 << 4) | h3);
        context_zbuf_append_utf8(&value, codepoint);
        cursor += 5;
        continue;
      }
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

char *context_root_pointer_path(const char *storage) {
  if (!storage) return NULL;
  return context_join_path(storage, "root.json");
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

char *context_node_path(const char *storage, const char *hash) {
  if (!storage || !hash) return NULL;
  const char *bare_hash = strncmp(hash, "sha256:", 7) == 0 ? hash + 7 : hash;
  char *nodes = context_join_path(storage, "nodes");
  ZBuf filename;
  zbuf_init(&filename);
  zbuf_append(&filename, bare_hash);
  zbuf_append(&filename, ".json");
  char *file = context_join_path(nodes, filename.data);
  free(nodes);
  zbuf_free(&filename);
  return file;
}

char *context_event_path(const char *storage, const char *event_hash) {
  if (!storage || !event_hash) return NULL;
  const char *bare_hash = strncmp(event_hash, "sha256:", 7) == 0 ? event_hash + 7 : event_hash;
  char *events = context_join_path(storage, "events");
  ZBuf filename;
  zbuf_init(&filename);
  zbuf_append(&filename, bare_hash);
  zbuf_append(&filename, ".json");
  char *file = context_join_path(events, filename.data);
  free(events);
  zbuf_free(&filename);
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

typedef struct {
  char *key;
  char *value;
} ContextJsonPair;

static int context_json_pair_cmp(const void *left, const void *right) {
  const ContextJsonPair *a = (const ContextJsonPair *)left;
  const ContextJsonPair *b = (const ContextJsonPair *)right;
  return strcmp(a->key, b->key);
}

static bool context_json_is_excluded(const char *key, const char *const *excluded_keys) {
  if (!key || !excluded_keys) return false;
  for (size_t i = 0; excluded_keys[i]; i++) {
    if (strcmp(key, excluded_keys[i]) == 0) return true;
  }
  return false;
}

static void context_json_append_escaped_string(ZBuf *out, const char *text) {
  static const char hex[] = "0123456789abcdef";
  zbuf_append_char(out, '"');
  for (const unsigned char *cursor = (const unsigned char *)(text ? text : ""); *cursor; cursor++) {
    unsigned char ch = *cursor;
    if (ch == '"') zbuf_append(out, "\\\"");
    else if (ch == '\\') zbuf_append(out, "\\\\");
    else if (ch == '\b') zbuf_append(out, "\\b");
    else if (ch == '\f') zbuf_append(out, "\\f");
    else if (ch == '\n') zbuf_append(out, "\\n");
    else if (ch == '\r') zbuf_append(out, "\\r");
    else if (ch == '\t') zbuf_append(out, "\\t");
    else if (ch < 0x20u) {
      zbuf_append(out, "\\u00");
      zbuf_append_char(out, hex[(ch >> 4) & 0xf]);
      zbuf_append_char(out, hex[ch & 0xf]);
    } else {
      zbuf_append_char(out, (char)ch);
    }
  }
  zbuf_append_char(out, '"');
}

void context_diagnostic_free(ContextDiagnostic *diagnostic) {
  if (!diagnostic) return;
  free(diagnostic->severity);
  free(diagnostic->code);
  free(diagnostic->message);
  free(diagnostic->node_id);
  free(diagnostic->hash);
  free(diagnostic->path);
  free(diagnostic->expected);
  free(diagnostic->actual);
  memset(diagnostic, 0, sizeof(*diagnostic));
}

static void context_diagnostic_append_string_field(ZBuf *diagnostics, const char *name, const char *value) {
  if (!value) return;
  zbuf_append(diagnostics, ",\"");
  zbuf_append(diagnostics, name);
  zbuf_append(diagnostics, "\":");
  context_json_append_escaped_string(diagnostics, value);
}

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
  const char *actual) {
  if (!diagnostics || !diagnostic_count || !code || !message) return;
  if (*diagnostic_count > 0) zbuf_append(diagnostics, ",");
  zbuf_append(diagnostics, "{\"severity\":");
  context_json_append_escaped_string(diagnostics, severity ? severity : "error");
  zbuf_append(diagnostics, ",\"code\":");
  context_json_append_escaped_string(diagnostics, code);
  zbuf_append(diagnostics, ",\"message\":");
  context_json_append_escaped_string(diagnostics, message);
  context_diagnostic_append_string_field(diagnostics, "nodeId", node_id);
  context_diagnostic_append_string_field(diagnostics, "hash", hash);
  context_diagnostic_append_string_field(diagnostics, "path", path);
  context_diagnostic_append_string_field(diagnostics, "expected", expected);
  context_diagnostic_append_string_field(diagnostics, "actual", actual);
  zbuf_append(diagnostics, "}");
  (*diagnostic_count)++;
}

static bool context_json_canonicalize_value(ZBuf *out, const char **cursor, const char *const *excluded_keys, bool apply_exclusions);
static int context_string_cmp(const void *left, const void *right);
static char **context_json_string_array(const char *json, size_t *out_count);

static bool context_json_canonicalize_string_value(ZBuf *out, const char **cursor) {
  const char *end = NULL;
  char *decoded = context_json_parse_string_at(*cursor, &end);
  if (!decoded) return false;
  context_json_append_escaped_string(out, decoded);
  free(decoded);
  *cursor = end;
  return true;
}

static bool context_json_canonicalize_literal(ZBuf *out, const char **cursor, const char *literal) {
  size_t len = strlen(literal);
  if (strncmp(*cursor, literal, len) != 0) return false;
  zbuf_append(out, literal);
  *cursor += len;
  return true;
}

static bool context_json_canonicalize_number(ZBuf *out, const char **cursor) {
  const char *start = *cursor;
  if (**cursor == '-') (*cursor)++;
  if (!isdigit((unsigned char)**cursor)) return false;
  if (**cursor == '0') {
    (*cursor)++;
  } else {
    while (isdigit((unsigned char)**cursor)) (*cursor)++;
  }
  if (**cursor == '.') {
    (*cursor)++;
    if (!isdigit((unsigned char)**cursor)) return false;
    while (isdigit((unsigned char)**cursor)) (*cursor)++;
  }
  if (**cursor == 'e' || **cursor == 'E') {
    (*cursor)++;
    if (**cursor == '+' || **cursor == '-') (*cursor)++;
    if (!isdigit((unsigned char)**cursor)) return false;
    while (isdigit((unsigned char)**cursor)) (*cursor)++;
  }
  context_zbuf_append_len(out, start, (size_t)(*cursor - start));
  return true;
}

static bool context_json_canonicalize_array(ZBuf *out, const char **cursor) {
  if (**cursor != '[') return false;
  zbuf_append_char(out, '[');
  (*cursor)++;
  *cursor = context_json_skip_ws(*cursor);
  bool first = true;
  while (**cursor && **cursor != ']') {
    if (!first) zbuf_append_char(out, ',');
    if (!context_json_canonicalize_value(out, cursor, NULL, false)) return false;
    *cursor = context_json_skip_ws(*cursor);
    if (**cursor == ',') {
      (*cursor)++;
      *cursor = context_json_skip_ws(*cursor);
    } else if (**cursor != ']') {
      return false;
    }
    first = false;
  }
  if (**cursor != ']') return false;
  zbuf_append_char(out, ']');
  (*cursor)++;
  return true;
}

static bool context_json_canonicalize_object(ZBuf *out, const char **cursor, const char *const *excluded_keys, bool apply_exclusions) {
  if (**cursor != '{') return false;
  (*cursor)++;
  *cursor = context_json_skip_ws(*cursor);
  ContextJsonPair *pairs = NULL;
  size_t count = 0;
  size_t cap = 0;
  bool ok = true;
  while (**cursor && **cursor != '}') {
    const char *key_end = NULL;
    char *key = context_json_parse_string_at(*cursor, &key_end);
    if (!key) {
      ok = false;
      break;
    }
    *cursor = context_json_skip_ws(key_end);
    if (**cursor != ':') {
      free(key);
      ok = false;
      break;
    }
    (*cursor)++;
    bool excluded = apply_exclusions && context_json_is_excluded(key, excluded_keys);
    ZBuf value;
    zbuf_init(&value);
    if (!context_json_canonicalize_value(&value, cursor, NULL, false)) {
      free(key);
      zbuf_free(&value);
      ok = false;
      break;
    }
    if (!excluded) {
      if (count == cap) {
        cap = cap ? cap * 2 : 8;
        pairs = z_checked_reallocarray(pairs, cap, sizeof(ContextJsonPair));
      }
      pairs[count].key = key;
      pairs[count].value = value.data ? value.data : z_strdup("");
      count++;
    } else {
      free(key);
      zbuf_free(&value);
    }
    *cursor = context_json_skip_ws(*cursor);
    if (**cursor == ',') {
      (*cursor)++;
      *cursor = context_json_skip_ws(*cursor);
    } else if (**cursor != '}') {
      ok = false;
      break;
    }
  }
  if (ok && **cursor != '}') ok = false;
  if (ok) (*cursor)++;
  if (ok) {
    qsort(pairs, count, sizeof(ContextJsonPair), context_json_pair_cmp);
    zbuf_append_char(out, '{');
    for (size_t i = 0; i < count; i++) {
      if (i > 0) zbuf_append_char(out, ',');
      context_json_append_escaped_string(out, pairs[i].key);
      zbuf_append_char(out, ':');
      zbuf_append(out, pairs[i].value);
    }
    zbuf_append_char(out, '}');
  }
  for (size_t i = 0; i < count; i++) {
    free(pairs[i].key);
    free(pairs[i].value);
  }
  free(pairs);
  return ok;
}

static bool context_json_canonicalize_value(ZBuf *out, const char **cursor, const char *const *excluded_keys, bool apply_exclusions) {
  *cursor = context_json_skip_ws(*cursor);
  if (!*cursor || !**cursor) return false;
  if (**cursor == '"') return context_json_canonicalize_string_value(out, cursor);
  if (**cursor == '{') return context_json_canonicalize_object(out, cursor, excluded_keys, apply_exclusions);
  if (**cursor == '[') return context_json_canonicalize_array(out, cursor);
  if (**cursor == 't') return context_json_canonicalize_literal(out, cursor, "true");
  if (**cursor == 'f') return context_json_canonicalize_literal(out, cursor, "false");
  if (**cursor == 'n') return context_json_canonicalize_literal(out, cursor, "null");
  return context_json_canonicalize_number(out, cursor);
}

bool context_json_canonicalize_excluding(ZBuf *out, const char *json, const char *const *excluded_keys) {
  if (!out || !json) return false;
  const char *cursor = json;
  if (!context_json_canonicalize_value(out, &cursor, excluded_keys, true)) return false;
  cursor = context_json_skip_ws(cursor);
  return *cursor == 0;
}

bool context_json_canonicalize(ZBuf *out, const char *json) {
  return context_json_canonicalize_excluding(out, json, NULL);
}

static char *context_prefixed_sha256(const char *data, size_t len) {
  unsigned char digest[Z_SHA256_DIGEST_LEN];
  char hex[65];
  z_sha256_hash((const unsigned char *)data, len, digest);
  z_sha256_hex(digest, hex);
  ZBuf out;
  zbuf_init(&out);
  zbuf_append(&out, "sha256:");
  zbuf_append(&out, hex);
  return out.data;
}

char *context_event_hash(const char *event_json) {
  const char *excluded[] = {"eventHash", NULL};
  ZBuf canonical;
  zbuf_init(&canonical);
  if (!context_json_canonicalize_excluding(&canonical, event_json, excluded)) {
    zbuf_free(&canonical);
    return NULL;
  }
  char *hash = context_prefixed_sha256(canonical.data, canonical.len);
  zbuf_free(&canonical);
  return hash;
}

char *context_node_lifecycle_state(const char *node_json) {
  char *state = context_json_get_nested_string(node_json, "lifecycle", "state", NULL);
  return state ? state : z_strdup("active");
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

char **context_source_index_all_hashes(const char *storage, size_t *out_count) {
  if (out_count) *out_count = 0;
  if (!storage || !out_count) return NULL;
  char *indexes = context_join_path(storage, "indexes");
  char *index_file = context_join_path(indexes, "source-index.json");
  ZDiag diag = {0};
  char *json = z_read_file(index_file, &diag);
  free(indexes);
  free(index_file);
  if (!json) return NULL;

  const char *sources = context_json_member_value(json, "sources");
  sources = context_json_skip_ws(sources);
  if (!sources || *sources != '{') {
    free(json);
    return NULL;
  }
  const char *sources_end = context_json_value_end(sources);
  const char *cursor = sources + 1;
  size_t cap = 0;
  char **hashes = NULL;
  while (cursor && sources_end && cursor < sources_end) {
    cursor = context_json_skip_ws(cursor);
    if (*cursor == '}') break;
    if (*cursor != '"') break;
    const char *key_end = NULL;
    char *key = context_json_parse_string_at(cursor, &key_end);
    free(key);
    if (!key_end) break;
    cursor = context_json_skip_ws(key_end);
    if (*cursor != ':') break;
    cursor = context_json_skip_ws(cursor + 1);
    const char *value_end = context_json_value_end(cursor);
    if (!value_end) break;
    if (*cursor == '[') {
      ZBuf raw;
      zbuf_init(&raw);
      context_zbuf_append_len(&raw, cursor, (size_t)(value_end - cursor));
      size_t field_count = 0;
      char **field_hashes = context_json_string_array(raw.data, &field_count);
      for (size_t i = 0; i < field_count; i++) {
        if (*out_count == cap) {
          cap = cap ? cap * 2 : 8;
          hashes = z_checked_reallocarray(hashes, cap, sizeof(char *));
        }
        hashes[(*out_count)++] = field_hashes[i];
      }
      free(field_hashes);
      zbuf_free(&raw);
    }
    cursor = context_json_skip_ws(value_end);
    if (*cursor == ',') cursor++;
  }
  free(json);
  if (*out_count > 1) qsort(hashes, *out_count, sizeof(char *), context_string_cmp);
  size_t write = 0;
  for (size_t i = 0; i < *out_count; i++) {
    if (write == 0 || strcmp(hashes[i], hashes[write - 1]) != 0) {
      hashes[write++] = hashes[i];
    } else {
      free(hashes[i]);
    }
  }
  *out_count = write;
  return hashes;
}

char **context_event_filenames(const char *storage, size_t *out_count) {
  if (out_count) *out_count = 0;
  if (!storage || !out_count) return NULL;
  char *events = context_join_path(storage, "events");
  DIR *dir = opendir(events);
  free(events);
  if (!dir) return NULL;
  char **filenames = NULL;
  size_t count = 0;
  size_t cap = 0;
  struct dirent *entry = NULL;
  while ((entry = readdir(dir)) != NULL) {
    size_t len = strlen(entry->d_name);
    if (len <= 5 || strcmp(entry->d_name + len - 5, ".json") != 0) continue;
    if (count == cap) {
      cap = cap ? cap * 2 : 8;
      filenames = z_checked_reallocarray(filenames, cap, sizeof(char *));
    }
    filenames[count++] = z_strdup(entry->d_name);
  }
  closedir(dir);
  if (count > 1) qsort(filenames, count, sizeof(char *), context_string_cmp);
  *out_count = count;
  return filenames;
}

char *context_read_node(const char *storage, const char *hash) {
  char *node_file = context_node_path(storage, hash);
  if (!node_file) return NULL;
  ZDiag diag = {0};
  char *json = z_read_file(node_file, &diag);
  free(node_file);
  return json;
}

char *context_read_root_snapshot(const char *storage, const char *current_root) {
  char *snapshot_path = context_root_snapshot_path(storage, current_root);
  if (!snapshot_path) return NULL;
  ZDiag diag = {0};
  char *json = z_read_file(snapshot_path, &diag);
  free(snapshot_path);
  return json;
}

static int context_string_cmp(const void *left, const void *right) {
  const char *const *a = (const char *const *)left;
  const char *const *b = (const char *const *)right;
  return strcmp(*a, *b);
}

static char **context_json_string_array(const char *json, size_t *out_count) {
  if (out_count) *out_count = 0;
  if (!json || !out_count) return NULL;
  const char *cursor = context_json_skip_ws(json);
  if (!cursor || *cursor != '[') return NULL;
  cursor++;
  size_t cap = 0;
  char **items = NULL;
  while (*cursor) {
    cursor = context_json_skip_ws(cursor);
    if (*cursor == ']') break;
    if (*cursor != '"') break;
    const char *end = NULL;
    char *value = context_json_parse_string_at(cursor, &end);
    if (!value) break;
    if (*out_count == cap) {
      cap = cap ? cap * 2 : 8;
      items = z_checked_reallocarray(items, cap, sizeof(char *));
    }
    items[(*out_count)++] = value;
    cursor = context_json_skip_ws(end);
    if (*cursor == ',') cursor++;
  }
  if (*out_count > 1) qsort(items, *out_count, sizeof(char *), context_string_cmp);
  size_t write = 0;
  for (size_t i = 0; i < *out_count; i++) {
    if (write == 0 || strcmp(items[i], items[write - 1]) != 0) {
      items[write++] = items[i];
    } else {
      free(items[i]);
    }
  }
  *out_count = write;
  return items;
}

static void context_hash_array_add(char ***items, size_t *count, size_t *cap, char *hash) {
  if (!hash) return;
  if (*count == *cap) {
    *cap = *cap ? *cap * 2 : 8;
    *items = z_checked_reallocarray(*items, *cap, sizeof(char *));
  }
  (*items)[(*count)++] = hash;
}

static void context_hash_array_extend_field(char ***items, size_t *count, size_t *cap, const char *root_snapshot_json, const char *field) {
  ZBuf raw;
  zbuf_init(&raw);
  if (!context_json_emit_field(&raw, root_snapshot_json, field)) {
    zbuf_free(&raw);
    return;
  }
  size_t field_count = 0;
  char **field_hashes = context_json_string_array(raw.data, &field_count);
  for (size_t i = 0; i < field_count; i++) context_hash_array_add(items, count, cap, field_hashes[i]);
  free(field_hashes);
  zbuf_free(&raw);
}

static char **context_root_hashes_for_fields(const char *root_snapshot_json, const char *const *fields, size_t *out_count) {
  if (out_count) *out_count = 0;
  if (!root_snapshot_json || !out_count) return NULL;
  char **items = NULL;
  size_t count = 0;
  size_t cap = 0;
  for (size_t i = 0; fields[i]; i++) {
    context_hash_array_extend_field(&items, &count, &cap, root_snapshot_json, fields[i]);
  }
  if (count > 1) qsort(items, count, sizeof(char *), context_string_cmp);
  size_t write = 0;
  for (size_t i = 0; i < count; i++) {
    if (write == 0 || strcmp(items[i], items[write - 1]) != 0) {
      items[write++] = items[i];
    } else {
      free(items[i]);
    }
  }
  *out_count = write;
  return items;
}

char **context_root_active_hashes(const char *root_snapshot_json, size_t *out_count) {
  const char *active_fields[] = {"activeNodes", NULL};
  char **items = context_root_hashes_for_fields(root_snapshot_json, active_fields, out_count);
  if (out_count && *out_count > 0) return items;
  free(items);
  const char *legacy_fields[] = {"nodes", NULL};
  return context_root_hashes_for_fields(root_snapshot_json, legacy_fields, out_count);
}

char **context_root_all_hashes(const char *root_snapshot_json, size_t *out_count) {
  size_t active_count = 0;
  char **active = context_root_active_hashes(root_snapshot_json, &active_count);
  char **items = NULL;
  size_t count = 0;
  size_t cap = 0;
  for (size_t i = 0; i < active_count; i++) context_hash_array_add(&items, &count, &cap, active[i]);
  free(active);
  context_hash_array_extend_field(&items, &count, &cap, root_snapshot_json, "supersededNodes");
  context_hash_array_extend_field(&items, &count, &cap, root_snapshot_json, "archivedNodes");
  if (count > 1) qsort(items, count, sizeof(char *), context_string_cmp);
  size_t write = 0;
  for (size_t i = 0; i < count; i++) {
    if (write == 0 || strcmp(items[i], items[write - 1]) != 0) {
      items[write++] = items[i];
    } else {
      free(items[i]);
    }
  }
  if (out_count) *out_count = write;
  return items;
}

static char **context_root_hash_array_field(const char *root_snapshot_json, const char *field, size_t *out_count, bool *present) {
  if (out_count) *out_count = 0;
  if (present) *present = false;
  ZBuf raw;
  zbuf_init(&raw);
  if (!context_json_emit_field(&raw, root_snapshot_json, field)) {
    zbuf_free(&raw);
    return NULL;
  }
  if (present) *present = true;
  char **hashes = context_json_string_array(raw.data, out_count);
  zbuf_free(&raw);
  return hashes;
}

static void context_append_string_array(ZBuf *out, char **items, size_t count) {
  zbuf_append_char(out, '[');
  for (size_t i = 0; i < count; i++) {
    if (i > 0) zbuf_append_char(out, ',');
    context_json_append_escaped_string(out, items[i]);
  }
  zbuf_append_char(out, ']');
}

static void context_free_string_array(char **items, size_t count) {
  for (size_t i = 0; i < count; i++) free(items[i]);
  free(items);
}

char *context_root_payload_hash(const char *root_snapshot_json) {
  if (!root_snapshot_json) return NULL;
  bool active_present = false;
  size_t active_count = 0;
  char **active = context_root_hash_array_field(root_snapshot_json, "activeNodes", &active_count, &active_present);
  if (!active_present) active = context_root_hash_array_field(root_snapshot_json, "nodes", &active_count, NULL);

  size_t superseded_count = 0;
  char **superseded = context_root_hash_array_field(root_snapshot_json, "supersededNodes", &superseded_count, NULL);
  size_t archived_count = 0;
  char **archived = context_root_hash_array_field(root_snapshot_json, "archivedNodes", &archived_count, NULL);

  bool parent_is_null = false;
  char *parent_root = context_json_get_string_or_null(root_snapshot_json, "parentRoot", &parent_is_null);
  char *reason = context_json_get_string_or_null(root_snapshot_json, "reason", NULL);
  if (!reason) reason = z_strdup("manual");
  char *source_index = context_json_get_nested_string(root_snapshot_json, "indexes", "sourceIndex", NULL);
  if (!source_index) source_index = z_strdup(".zero/context/indexes/source-index.json");

  ZBuf payload;
  zbuf_init(&payload);
  zbuf_append(&payload, "{");
  zbuf_append(&payload, "\"schemaVersion\":1,");
  zbuf_append(&payload, "\"parentRoot\":");
  if (parent_root) context_json_append_escaped_string(&payload, parent_root);
  else zbuf_append(&payload, "null");
  zbuf_append(&payload, ",\"reason\":");
  context_json_append_escaped_string(&payload, reason);
  zbuf_append(&payload, ",\"activeNodes\":");
  context_append_string_array(&payload, active, active_count);
  zbuf_append(&payload, ",\"nodes\":");
  context_append_string_array(&payload, active, active_count);
  zbuf_append(&payload, ",\"supersededNodes\":");
  context_append_string_array(&payload, superseded, superseded_count);
  zbuf_append(&payload, ",\"archivedNodes\":");
  context_append_string_array(&payload, archived, archived_count);
  zbuf_append(&payload, ",\"createdAt\":null,\"indexes\":{\"sourceIndex\":");
  context_json_append_escaped_string(&payload, source_index);
  zbuf_append(&payload, "}}");

  ZBuf canonical;
  zbuf_init(&canonical);
  char *hash = NULL;
  if (context_json_canonicalize(&canonical, payload.data)) {
    hash = context_prefixed_sha256(canonical.data, canonical.len);
  }
  zbuf_free(&canonical);
  zbuf_free(&payload);
  context_free_string_array(active, active_count);
  context_free_string_array(superseded, superseded_count);
  context_free_string_array(archived, archived_count);
  free(parent_root);
  free(reason);
  free(source_index);
  (void)parent_is_null;
  return hash;
}

void context_compliance_root_state_free(ContextComplianceRootState *state) {
  if (!state) return;
  free(state->pointer_json);
  free(state->current_root);
  free(state->current_root_snapshot_json);
  memset(state, 0, sizeof(*state));
}

static bool context_path_exists(const char *path) {
  if (!path) return false;
  struct stat st;
  return stat(path, &st) == 0;
}

static bool context_hash_list_contains(char **items, size_t count, const char *hash) {
  if (!hash) return false;
  for (size_t i = 0; i < count; i++) {
    if (items[i] && strcmp(items[i], hash) == 0) return true;
  }
  return false;
}

static bool context_json_field_is_array(const char *json, const char *field, bool required) {
  ZBuf raw;
  zbuf_init(&raw);
  if (!context_json_emit_field(&raw, json, field)) {
    zbuf_free(&raw);
    return !required;
  }
  const char *cursor = context_json_skip_ws(raw.data);
  bool ok = cursor && *cursor == '[';
  zbuf_free(&raw);
  return ok;
}

static bool context_root_snapshot_schema_ok(const char *json) {
  int schema_version = 0;
  if (!context_json_get_int(json, "schemaVersion", &schema_version) || schema_version != 1) return false;
  char *context_root = context_json_get_string_or_null(json, "contextRoot", NULL);
  if (!context_root) return false;
  free(context_root);
  bool parent_is_null = false;
  char *parent_root = context_json_get_string_or_null(json, "parentRoot", &parent_is_null);
  if (!parent_root && !parent_is_null) return false;
  free(parent_root);
  char *reason = context_json_get_string_or_null(json, "reason", NULL);
  if (!reason) return false;
  free(reason);
  if (!context_json_field_is_array(json, "activeNodes", true)) return false;
  if (!context_json_field_is_array(json, "supersededNodes", true)) return false;
  if (!context_json_field_is_array(json, "archivedNodes", false)) return false;
  if (!context_json_field_is_array(json, "nodes", true)) return false;
  char *source_index = context_json_get_nested_string(json, "indexes", "sourceIndex", NULL);
  if (!source_index) return false;
  free(source_index);
  return true;
}

static char *context_snapshot_filename_hash(const char *snapshot_path) {
  if (!snapshot_path) return NULL;
  const char *base = strrchr(snapshot_path, '/');
  const char *backslash = strrchr(snapshot_path, '\\');
  if (backslash && (!base || backslash > base)) base = backslash;
  base = base ? base + 1 : snapshot_path;
  size_t len = strlen(base);
  if (len > 5 && strcmp(base + len - 5, ".json") == 0) len -= 5;
  ZBuf out;
  zbuf_init(&out);
  context_zbuf_append_len(&out, base, len);
  return out.data;
}

static const char *context_bare_hash(const char *hash) {
  return hash && strncmp(hash, "sha256:", 7) == 0 ? hash + 7 : hash;
}

static bool context_json_valid_document(const char *json) {
  ZBuf canonical;
  zbuf_init(&canonical);
  bool ok = context_json_canonicalize(&canonical, json);
  zbuf_free(&canonical);
  return ok;
}

void context_compliance_read_root(
  const char *storage,
  ContextComplianceRootState *state,
  ZBuf *diagnostics,
  size_t *diagnostic_count) {
  if (!state) return;
  memset(state, 0, sizeof(*state));
  char *root_path = context_root_pointer_path(storage);
  if (!root_path || !context_path_exists(root_path)) {
    context_diagnostic_append(
      diagnostics,
      diagnostic_count,
      NULL,
      "CTX_COMPLIANCE_ROOT_MISSING",
      "context root pointer does not exist",
      NULL,
      NULL,
      root_path,
      NULL,
      NULL);
    free(root_path);
    return;
  }

  ZDiag read_diag = {0};
  char *pointer_json = z_read_file(root_path, &read_diag);
  int schema_version = 0;
  char *current_root = pointer_json ? context_json_get_string_or_null(pointer_json, "currentRoot", NULL) : NULL;
  if (!pointer_json || !context_json_get_int(pointer_json, "schemaVersion", &schema_version) || schema_version != 1 || !current_root) {
    context_diagnostic_append(
      diagnostics,
      diagnostic_count,
      NULL,
      "CTX_COMPLIANCE_ROOT_POINTER_MALFORMED",
      pointer_json ? "context root pointer has an unsupported schema" : "context root pointer is not valid JSON",
      NULL,
      NULL,
      root_path,
      NULL,
      NULL);
    free(pointer_json);
    free(current_root);
    free(root_path);
    return;
  }

  state->pointer_json = pointer_json;
  state->current_root = current_root;

  char **visited = NULL;
  size_t visited_count = 0;
  size_t visited_cap = 0;
  char *current_hash = z_strdup(state->current_root);
  bool parent_chain_ok = true;

  while (current_hash) {
    if (context_hash_list_contains(visited, visited_count, current_hash)) {
      parent_chain_ok = false;
      char *cycle_path = context_root_snapshot_path(storage, current_hash);
      context_diagnostic_append(
        diagnostics,
        diagnostic_count,
        NULL,
        "CTX_COMPLIANCE_PARENT_CHAIN_BROKEN",
        "context root parent chain contains a cycle",
        NULL,
        current_hash,
        cycle_path,
        NULL,
        NULL);
      free(cycle_path);
      break;
    }
    context_hash_array_add(&visited, &visited_count, &visited_cap, z_strdup(current_hash));

    char *snapshot_path = context_root_snapshot_path(storage, current_hash);
    bool is_current_root = strcmp(current_hash, state->current_root) == 0;
    if (!snapshot_path || !context_path_exists(snapshot_path)) {
      parent_chain_ok = false;
      context_diagnostic_append(
        diagnostics,
        diagnostic_count,
        NULL,
        is_current_root ? "CTX_COMPLIANCE_ROOT_SNAPSHOT_MISSING" : "CTX_COMPLIANCE_PARENT_ROOT_MISSING",
        is_current_root ? "current root snapshot does not exist" : "parent root snapshot does not exist",
        NULL,
        current_hash,
        snapshot_path,
        NULL,
        NULL);
      free(snapshot_path);
      break;
    }

    ZDiag snapshot_diag = {0};
    char *snapshot_json = z_read_file(snapshot_path, &snapshot_diag);
    if (!snapshot_json || !context_json_valid_document(snapshot_json)) {
      parent_chain_ok = false;
      context_diagnostic_append(
        diagnostics,
        diagnostic_count,
        NULL,
        "CTX_COMPLIANCE_PARENT_CHAIN_BROKEN",
        snapshot_json ? "root snapshot is not valid JSON" : "root snapshot is not readable",
        NULL,
        current_hash,
        snapshot_path,
        NULL,
        NULL);
      free(snapshot_json);
      free(snapshot_path);
      break;
    }
    if (!context_root_snapshot_schema_ok(snapshot_json)) {
      parent_chain_ok = false;
      context_diagnostic_append(
        diagnostics,
        diagnostic_count,
        NULL,
        "CTX_COMPLIANCE_PARENT_CHAIN_BROKEN",
        "root snapshot has an unsupported schema",
        NULL,
        current_hash,
        snapshot_path,
        NULL,
        NULL);
      free(snapshot_json);
      free(snapshot_path);
      break;
    }

    state->root_depth += 1;
    if (is_current_root) state->current_root_snapshot_json = z_strdup(snapshot_json);

    char *snapshot_root = context_json_get_string_or_null(snapshot_json, "contextRoot", NULL);
    char *filename_hash = context_snapshot_filename_hash(snapshot_path);
    const char *snapshot_root_bare = context_bare_hash(snapshot_root);
    if (snapshot_root_bare && filename_hash && strcmp(filename_hash, snapshot_root_bare) != 0) {
      context_diagnostic_append(
        diagnostics,
        diagnostic_count,
        NULL,
        "CTX_COMPLIANCE_FILENAME_MISMATCH",
        "root snapshot filename does not match its contextRoot field",
        NULL,
        snapshot_root_bare,
        snapshot_path,
        snapshot_root_bare,
        filename_hash);
    }

    char *expected_root = context_root_payload_hash(snapshot_json);
    if (!snapshot_root || !expected_root || strcmp(snapshot_root, current_hash) != 0 || strcmp(snapshot_root, expected_root) != 0) {
      parent_chain_ok = false;
      if (is_current_root) state->root_hash_ok = false;
      context_diagnostic_append(
        diagnostics,
        diagnostic_count,
        NULL,
        "CTX_COMPLIANCE_ROOT_HASH_MISMATCH",
        "root snapshot hash does not match canonical payload",
        NULL,
        current_hash,
        snapshot_path,
        snapshot_root,
        expected_root);
    } else if (is_current_root) {
      state->root_hash_ok = true;
    }

    bool parent_is_null = false;
    char *next_hash = context_json_get_string_or_null(snapshot_json, "parentRoot", &parent_is_null);
    free(current_hash);
    current_hash = parent_is_null ? NULL : next_hash;
    if (parent_is_null) free(next_hash);
    free(snapshot_root);
    free(filename_hash);
    free(expected_root);
    free(snapshot_json);
    free(snapshot_path);
  }

  free(current_hash);
  context_free_string_array(visited, visited_count);
  state->parent_chain_ok = parent_chain_ok && state->current_root_snapshot_json != NULL;
  free(root_path);
}
