#ifndef ZERO_HASH_H
#define ZERO_HASH_H

#include <stddef.h>
#include <stdint.h>

#define Z_SHA256_DIGEST_LEN 32

typedef struct {
  uint32_t state[8];
  uint64_t bitlen;
  unsigned char buffer[64];
  size_t buffer_len;
} ZSha256;

void z_sha256_init(ZSha256 *ctx);
void z_sha256_update(ZSha256 *ctx, const unsigned char *data, size_t len);
void z_sha256_final(ZSha256 *ctx, unsigned char hash[Z_SHA256_DIGEST_LEN]);
void z_sha256_hash(const unsigned char *data, size_t len, unsigned char hash[Z_SHA256_DIGEST_LEN]);
void z_sha256_hex(const unsigned char hash[Z_SHA256_DIGEST_LEN], char hex[65]);

#endif
