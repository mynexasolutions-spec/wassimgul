import { v2 as cloudinary } from 'cloudinary';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import zlib from 'zlib';

export function getCloudinaryClient() {
  cloudinary.config({
    cloud_name:
      process.env.CLOUDINARY_CLOUD_NAME ||
      process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ||
      'z9k7qar8',
    api_key:
      process.env.CLOUDINARY_API_KEY ||
      process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY ||
      '849612657253566',
    api_secret:
      process.env.CLOUDINARY_API_SECRET ||
      process.env.NEXT_PUBLIC_CLOUDINARY_API_SECRET ||
      '',
    secure: true,
  });
  return cloudinary;
}

/**
 * Smart adaptive image compression for Cloudinary:
 * Compresses 10MB - 50MB images to fit under Cloudinary's 10MB free limit
 * while strictly preserving maximum visual quality and sharpness.
 */
async function compressImageForCloudinary(buffer, mimeType) {
  try {
    const isPng = mimeType === 'image/png';
    const isWebp = mimeType === 'image/webp';

    const passes = [
      { maxDim: 2400, quality: 84 },
      { maxDim: 2048, quality: 78 },
      { maxDim: 1800, quality: 70 },
      { maxDim: 1500, quality: 62 },
    ];

    let current = buffer;
    for (const pass of passes) {
      if (current.length <= 9.5 * 1024 * 1024 && current !== buffer) {
        return current;
      }
      let pipeline = sharp(buffer);
      pipeline = pipeline.resize({
        width: pass.maxDim,
        height: pass.maxDim,
        fit: 'inside',
        withoutEnlargement: true,
      });

      let compressed;
      if (isPng) {
        compressed = await pipeline.png({ quality: pass.quality, compressionLevel: 8 }).toBuffer();
      } else if (isWebp) {
        compressed = await pipeline.webp({ quality: pass.quality, effort: 6 }).toBuffer();
      } else {
        compressed = await pipeline.jpeg({ quality: pass.quality, mozjpeg: true }).toBuffer();
      }

      if (compressed.length < current.length || current === buffer) {
        current = compressed;
      }
      if (current.length <= 9.5 * 1024 * 1024) {
        return current;
      }
    }
    return current;
  } catch (err) {
    console.warn('[Cloudinary Provider] Image compression warning:', err.message);
    return buffer;
  }
}

function unpack1BitTo8Bit(packedBuf, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIdx = y * rowBytes + (x >> 3);
      if (byteIdx < packedBuf.length) {
        const bit = (packedBuf[byteIdx] >> (7 - (x & 7))) & 1;
        out[y * width + x] = bit ? 255 : 0;
      }
    }
  }
  return out;
}

/**
 * Smart PDF optimization & embedded image re-compression for Cloudinary:
 * Extracts large embedded images in PDF pages and re-encodes them with
 * high-fidelity mozjpeg compression to shrink 15-50MB PDFs below 10MB
 * while keeping 100% vector text, layout, and visual readability.
 */
async function compressPdfForCloudinary(buffer) {
  const passes = [
    { maxDim: 1200, quality: 45 },
    { maxDim: 950, quality: 38 },
  ];

  let resultBuffer = buffer;

  for (const pass of passes) {
    try {
      const pdfDoc = await PDFDocument.load(buffer, {
        ignoreEncryption: true,
        updateMetadata: false,
      });

      const context = pdfDoc.context;
      const objects = context.enumerateIndirectObjects();

      for (const [ref, obj] of objects) {
        if (obj instanceof PDFRawStream || (obj && obj.contents && obj.dict)) {
          const dict = obj.dict;
          const subtypeObj = context.lookup(dict.get(PDFName.of('Subtype')));
          const typeObj = context.lookup(dict.get(PDFName.of('Type')));
          const subtype = subtypeObj?.toString();
          const type = typeObj?.toString();

          if (
            subtype === '/Image' ||
            type === '/Image' ||
            (type === '/XObject' && subtype === '/Image') ||
            (!subtype && !type && obj.contents.length > 10000)
          ) {
            if (obj.contents && obj.contents.length > 5 * 1024) {
              try {
                const filterObj = context.lookup(dict.get(PDFName.of('Filter')));
                const filter = filterObj?.toString() || '';
                let rawBuffer = Buffer.from(obj.contents);

                if (filter.includes('FlateDecode')) {
                  try {
                    rawBuffer = zlib.inflateSync(rawBuffer);
                  } catch (_) {
                    try { rawBuffer = zlib.inflateRawSync(rawBuffer); } catch (_) {}
                  }
                }

                const widthObj = context.lookup(dict.get(PDFName.of('Width')));
                const heightObj = context.lookup(dict.get(PDFName.of('Height')));
                const csObj = context.lookup(dict.get(PDFName.of('ColorSpace')));
                const bpcObj = context.lookup(dict.get(PDFName.of('BitsPerComponent')));

                const width = widthObj?.asNumber?.() || 0;
                const height = heightObj?.asNumber?.() || 0;
                const bpc = bpcObj?.asNumber?.() || 8;
                const cs = csObj?.toString() || '';
                const isGray = cs.includes('Gray') || (!cs && bpc === 1);
                const channels = isGray ? 1 : 3;

                let imgPipeline = null;

                // Check if rawBuffer is already valid JPEG or PNG header
                if (rawBuffer.length > 4 && (rawBuffer[0] === 0xFF && rawBuffer[1] === 0xD8)) {
                  imgPipeline = sharp(rawBuffer);
                } else if (rawBuffer.length > 8 && (rawBuffer[0] === 0x89 && rawBuffer[1] === 0x50)) {
                  imgPipeline = sharp(rawBuffer);
                } else if (bpc === 1 && width > 0 && height > 0) {
                  // 1-bit monochrome scanned image: unpack to 8-bit grayscale
                  const unpacked = unpack1BitTo8Bit(rawBuffer, width, height);
                  imgPipeline = sharp(unpacked, { raw: { width, height, channels: 1 } });
                } else if (width > 0 && height > 0 && rawBuffer.length >= width * height) {
                  // Raw pixel scanline buffer
                  const effectiveChannels = rawBuffer.length >= width * height * 3 ? 3 : 1;
                  imgPipeline = sharp(rawBuffer, {
                    raw: { width, height, channels: effectiveChannels },
                  });
                } else {
                  // Fallback attempt direct sharp load
                  try { imgPipeline = sharp(rawBuffer); } catch (_) {}
                }

                if (imgPipeline) {
                  const meta = await imgPipeline.metadata().catch(() => null);
                  if (meta && meta.width && meta.height) {
                    if (meta.width > pass.maxDim || meta.height > pass.maxDim) {
                      imgPipeline = imgPipeline.resize({
                        width: pass.maxDim,
                        height: pass.maxDim,
                        fit: 'inside',
                        withoutEnlargement: true,
                      });
                    }
                    const compressedImg = await imgPipeline
                      .jpeg({ quality: pass.quality, mozjpeg: true })
                      .toBuffer();

                    if (compressedImg.length < obj.contents.length) {
                      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
                      dict.set(PDFName.of('Length'), PDFNumber.of(compressedImg.length));
                      dict.delete(PDFName.of('DecodeParms'));
                      dict.set(PDFName.of('ColorSpace'), PDFName.of(isGray ? 'DeviceGray' : 'DeviceRGB'));
                      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
                      context.assign(ref, PDFRawStream.of(dict, compressedImg));
                    }
                  }
                }
              } catch (_) {}
            }
          }
        }
      }

      const optimizedBytes = await pdfDoc.save({
        useObjectStreams: true,
        addDefaultPage: false,
      });

      resultBuffer = Buffer.from(optimizedBytes);
      if (resultBuffer.length <= 9.5 * 1024 * 1024) {
        return resultBuffer;
      }
    } catch (err) {
      console.warn('[Cloudinary Provider] PDF deep compression notice:', err.message);
      return buffer;
    }
  }

  return resultBuffer;
}

/**
 * Upload a file buffer to Cloudinary
 * Handles both images and PDFs/documents seamlessly
 */
export async function uploadToCloudinary(buffer, { fileName, folder, mimeType }) {
  const isImage = mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|tiff|gif|bmp)$/i.test(fileName);
  const isPdf = mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
  let uploadBuffer = buffer;

  // 1. If image buffer is over 9.5MB, optimize for Cloudinary's 10MB limit while maintaining high visual quality
  if (buffer.length > 9.5 * 1024 * 1024 && isImage) {
    try {
      console.info(`[Cloudinary Provider] Optimizing ${(buffer.length / 1024 / 1024).toFixed(1)}MB image for Cloudinary 10MB limit...`);
      const compressed = await compressImageForCloudinary(buffer, mimeType);
      if (compressed && compressed.length < buffer.length) {
        console.info(`[Cloudinary Provider] Image compressed from ${(buffer.length / 1024 / 1024).toFixed(1)}MB -> ${(compressed.length / 1024 / 1024).toFixed(1)}MB.`);
        uploadBuffer = compressed;
      }
    } catch (_) {}
  }

  // 2. If PDF buffer is over 9.5MB, optimize object streams and images
  if (buffer.length > 9.5 * 1024 * 1024 && isPdf) {
    try {
      console.info(`[Cloudinary Provider] Optimizing ${(buffer.length / 1024 / 1024).toFixed(1)}MB PDF for Cloudinary 10MB limit...`);
      const optimized = await compressPdfForCloudinary(buffer);
      if (optimized && optimized.length < buffer.length) {
        console.info(`[Cloudinary Provider] PDF compressed from ${(buffer.length / 1024 / 1024).toFixed(1)}MB -> ${(optimized.length / 1024 / 1024).toFixed(1)}MB.`);
        uploadBuffer = optimized;
      }
    } catch (_) {}
  }

  // If file still exceeds 10MB:
  // Gracefully skip Cloudinary so the pristine original file is preserved in ImageKit & Google Drive
  if (uploadBuffer.length > 10 * 1024 * 1024) {
    console.info(`[Cloudinary Provider] File size (${(uploadBuffer.length / 1024 / 1024).toFixed(1)}MB) exceeds Cloudinary 10MB limit. Pristine full-quality file is preserved in ImageKit & Google Drive.`);
    return null;
  }

  const client = getCloudinaryClient();
  return new Promise((resolve, reject) => {
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const folderPath = folder ? folder.replace(/^\//, '') : 'cases';

    const uploadStream = client.uploader.upload_stream(
      {
        folder: folderPath,
        public_id: `${cleanBaseName}_${Date.now()}`,
        resource_type: 'auto',
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) {
          console.error('[Cloudinary Provider] Upload error:', error);
          return reject(error);
        }
        resolve({
          provider: 'cloudinary',
          fileId: result.public_id,
          url: result.secure_url || result.url,
          resourceType: result.resource_type,
          format: result.format,
          bytes: result.bytes,
          raw: result,
        });
      }
    );

    uploadStream.end(uploadBuffer);
  });
}

/**
 * Delete a file from Cloudinary by publicId
 */
export async function deleteFromCloudinary(publicId, resourceType = 'auto') {
  if (!publicId) return;
  const client = getCloudinaryClient();

  try {
    if (resourceType === 'auto') {
      // Attempt image deletion first, then raw deletion if not found
      const res = await client.uploader.destroy(publicId, { resource_type: 'image' });
      if (res.result === 'ok') return res;
      return await client.uploader.destroy(publicId, { resource_type: 'raw' });
    }
    return await client.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('[Cloudinary Provider] Delete error:', err);
    throw err;
  }
}

/**
 * Delete a folder and its contents in Cloudinary
 */
export async function deleteFolderFromCloudinary(folderPath) {
  if (!folderPath) return;
  const cleanFolder = folderPath.replace(/^\//, '');
  const client = getCloudinaryClient();

  try {
    await client.api.delete_resources_by_prefix(cleanFolder, { resource_type: 'image' }).catch(() => {});
    await client.api.delete_resources_by_prefix(cleanFolder, { resource_type: 'raw' }).catch(() => {});
    await client.api.delete_folder(cleanFolder).catch(() => {});
  } catch (err) {
    console.error('[Cloudinary Provider] Delete folder error:', err);
  }
}

export default cloudinary;

