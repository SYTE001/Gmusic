use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

pub const MAX_IMAGE_DIMENSION: u32 = 8192;
pub const MAX_IMAGE_PIXELS: u64 = 48_000_000;
pub const MAX_RAW_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MIN_RAW_IMAGE_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

fn format_to_mime(format: ImageFormat) -> Option<&'static str> {
    match format {
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Png => Some("image/png"),
        ImageFormat::WebP => Some("image/webp"),
        ImageFormat::Gif => Some("image/gif"),
        ImageFormat::Bmp => Some("image/bmp"),
        _ => None,
    }
}

pub fn validate_and_inspect_image(bytes: &[u8]) -> Result<ValidatedImage, String> {
    if bytes.len() < MIN_RAW_IMAGE_BYTES {
        return Err("undersized".into());
    }
    if bytes.len() > MAX_RAW_IMAGE_BYTES {
        return Err("oversized".into());
    }
    let head = std::str::from_utf8(&bytes[..bytes.len().min(32)])
        .unwrap_or("")
        .trim_start()
        .to_ascii_lowercase();
    if head.starts_with("<!doctype") || head.starts_with("<html") || head.starts_with('{') {
        return Err("html-or-json".into());
    }

    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "decode-failed".to_string())?;
    let format = reader.format().ok_or_else(|| "invalid-mime".to_string())?;
    let mime_type = format_to_mime(format)
        .ok_or_else(|| "invalid-mime".to_string())?
        .to_string();

    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "decode-failed".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || (width as u64) * (height as u64) > MAX_IMAGE_PIXELS
    {
        return Err("oversized".into());
    }

    // Perform full decode with strict memory limits to guarantee image integrity
    let mut decode_reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "decode-failed".to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(192 * 1024 * 1024);
    decode_reader.limits(limits);
    let decoded = decode_reader
        .decode()
        .map_err(|_| "decode-failed".to_string())?;

    Ok(ValidatedImage {
        bytes: bytes.to_vec(),
        mime_type,
        width: decoded.width(),
        height: decoded.height(),
    })
}

#[cfg(test)]
thread_local! {
    static THUMBNAIL_DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub fn generate_thumbnail(
    source: &ValidatedImage,
    max_edge: u32,
) -> Result<ValidatedImage, String> {
    Ok(generate_thumbnails(source, &[max_edge])?.remove(0))
}

pub fn generate_thumbnails(
    source: &ValidatedImage,
    max_edges: &[u32],
) -> Result<Vec<ValidatedImage>, String> {
    let needs_resize = max_edges
        .iter()
        .any(|&edge| edge != 0 && (source.width > edge || source.height > edge));
    if !needs_resize {
        return Ok(max_edges.iter().map(|_| source.clone()).collect());
    }

    let mut reader = ImageReader::new(Cursor::new(&source.bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to read image for resize: {e}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(192 * 1024 * 1024);
    reader.limits(limits);

    #[cfg(test)]
    THUMBNAIL_DECODES.with(|count| count.set(count.get() + 1));
    let decoded = reader
        .decode()
        .map_err(|e| format!("Failed to decode image for resize: {e}"))?;
    max_edges
        .iter()
        .map(|&max_edge| {
            if max_edge == 0 || (source.width <= max_edge && source.height <= max_edge) {
                return Ok(source.clone());
            }
            encode_thumbnail(&decoded, source, max_edge)
        })
        .collect()
}

fn encode_thumbnail(
    decoded: &image::DynamicImage,
    source: &ValidatedImage,
    max_edge: u32,
) -> Result<ValidatedImage, String> {
    let resized = decoded.resize(max_edge, max_edge, FilterType::Triangle);
    let width = resized.width();
    let height = resized.height();

    let mut out = Vec::new();
    if source.mime_type == "image/png" && decoded.color().has_alpha() {
        resized
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .map_err(|e| format!("Failed to encode PNG thumbnail: {e}"))?;
        Ok(ValidatedImage {
            bytes: out,
            mime_type: "image/png".into(),
            width,
            height,
        })
    } else {
        let rgb = resized.to_rgb8();
        let mut encoder = JpegEncoder::new_with_quality(&mut out, 86);
        encoder
            .encode_image(&rgb)
            .map_err(|e| format!("Failed to encode JPEG thumbnail: {e}"))?;
        Ok(ValidatedImage {
            bytes: out,
            mime_type: "image/jpeg".into(),
            width,
            height,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::io::Cursor;

    fn make_test_image(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, |x, y| {
            Rgba([(x % 255) as u8, (y % 255) as u8, 128, 255])
        });
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), format).unwrap();
        buf
    }

    #[test]
    fn validates_real_images_and_rejects_corrupted_or_oversized_dimensions() {
        let png = make_test_image(800, 600, ImageFormat::Png);
        let validated = validate_and_inspect_image(&png).unwrap();
        assert_eq!(validated.width, 800);
        assert_eq!(validated.height, 600);
        assert_eq!(validated.mime_type, "image/png");
        assert_eq!(validated.bytes, png);

        // Rejects HTML / JSON / garbage bytes
        assert!(validate_and_inspect_image(b"<!DOCTYPE html><html></html>").is_err());
        assert!(validate_and_inspect_image(b"{\"error\":\"not found\"}").is_err());
        assert!(validate_and_inspect_image(&[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3
        ])
        .is_err());
    }

    #[test]
    fn thumbnail_pair_decodes_once_and_matches_individual_results() {
        let bytes = make_test_image(800, 600, ImageFormat::Png);
        let validated = validate_and_inspect_image(&bytes).unwrap();
        let expected = [
            generate_thumbnail(&validated, 500).unwrap(),
            generate_thumbnail(&validated, 256).unwrap(),
        ];
        THUMBNAIL_DECODES.with(|count| count.set(0));
        let thumbnails = generate_thumbnails(&validated, &[500, 256]).unwrap();
        assert_eq!(THUMBNAIL_DECODES.with(|count| count.get()), 1);
        assert_eq!(thumbnails, expected);
        for thumbnail in thumbnails {
            assert_eq!(
                validate_and_inspect_image(&thumbnail.bytes).unwrap(),
                thumbnail
            );
        }
        let small =
            validate_and_inspect_image(&make_test_image(120, 80, ImageFormat::Png)).unwrap();
        THUMBNAIL_DECODES.with(|count| count.set(0));
        assert_eq!(
            generate_thumbnails(&small, &[500, 256, 0]).unwrap(),
            vec![small.clone(), small.clone(), small]
        );
        assert_eq!(THUMBNAIL_DECODES.with(|count| count.get()), 0);
    }

    #[test]
    fn generates_thumbnails_preserving_aspect_ratio_and_never_upscaling() {
        // 1200x600 (2:1 aspect ratio) -> 500 max edge -> 500x250
        let wide = make_test_image(1200, 600, ImageFormat::Png);
        let validated = validate_and_inspect_image(&wide).unwrap();
        let thumb_500 = generate_thumbnail(&validated, 500).unwrap();
        assert_eq!(thumb_500.width, 500);
        assert_eq!(thumb_500.height, 250);

        let thumb_256 = generate_thumbnail(&validated, 256).unwrap();
        assert_eq!(thumb_256.width, 256);
        assert_eq!(thumb_256.height, 128);

        // 300x200 -> 500 max edge -> must NOT upscale (stays 300x200 and preserves original bytes)
        let small = make_test_image(300, 200, ImageFormat::Png);
        let val_small = validate_and_inspect_image(&small).unwrap();
        let no_upscale = generate_thumbnail(&val_small, 500).unwrap();
        assert_eq!(no_upscale.width, 300);
        assert_eq!(no_upscale.height, 200);
        assert_eq!(no_upscale.bytes, small);
    }
}
