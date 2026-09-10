// =============================================================================
// inflate.js —— zlib 解压封装（对应 msch.py 里的 zlib.decompress）
//
// 优先使用浏览器原生 DecompressionStream('deflate')（RFC1950 zlib 格式，
// 与 Mindustry 蓝图 / 处理器 byteArray 的压缩格式一致）。
// 该 API 在较新的 Chrome/Edge/Safari/Firefox 与 Node 18+ 均可用，无需第三方库。
// 若环境不支持，抛出明确中文错误。
// =============================================================================

/**
 * 解压 zlib 流。
 * @param {Uint8Array|ArrayBuffer} data zlib 压缩数据
 * @returns {Promise<Uint8Array>} 解压后的字节
 */
export async function inflate(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "当前浏览器不支持 DecompressionStream，无法解压蓝图数据。" +
        "请升级到较新版本的 Chrome / Edge / Safari / Firefox 后重试。"
    );
  }
  try {
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch (err) {
    throw new Error("解压失败（数据不是有效的 zlib 流）：" + (err && err.message ? err.message : err));
  }
}
