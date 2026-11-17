use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const MAX_EMBEDDED_ARTWORK_BYTES: usize = 16 * 1024 * 1024;
pub const MIN_EMBEDDED_ARTWORK_BYTES: usize = 64;
const ID3_SCAN_LIMIT: usize = 24 * 1024 * 1024;
const MP4_SCAN_LIMIT: usize = 8 * 1024 * 1024;
const OGG_SCAN_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedArtwork {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub picture_type: u8,
}

fn sniff_image_mime(bytes: &[u8], declared_mime: &str) -> Option<String> {
    if bytes.len() < MIN_EMBEDDED_ARTWORK_BYTES || bytes.len() > MAX_EMBEDDED_ARTWORK_BYTES {
        return None;
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg".into());
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png".into());
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp".into());
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif".into());
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp".into());
    }
    let clean = declared_mime.trim().to_ascii_lowercase();
    if clean == "-->" || clean.starts_with("text/") || clean.starts_with("application/") {
        return None;
    }
    None
}

fn syncsafe_u32(b: &[u8]) -> usize {
    (((b[0] & 0x7f) as usize) << 21)
        | (((b[1] & 0x7f) as usize) << 14)
        | (((b[2] & 0x7f) as usize) << 7)
        | ((b[3] & 0x7f) as usize)
}

fn skip_encoded_string(body: &[u8], pos: usize, encoding: u8) -> Option<usize> {
    if pos >= body.len() {
        return None;
    }
    if encoding == 1 || encoding == 2 {
        let mut cur = pos;
        while cur + 1 < body.len() {
            if body[cur] == 0 && body[cur + 1] == 0 {
                return Some(cur + 2);
            }
            cur += 2;
        }
        Some(body.len())
    } else {
        let mut cur = pos;
        while cur < body.len() {
            if body[cur] == 0 {
                return Some(cur + 1);
            }
            cur += 1;
        }
        Some(body.len())
    }
}

fn parse_id3_pic2(body: &[u8]) -> Option<ExtractedArtwork> {
    if body.len() < 6 {
        return None;
    }
    let encoding = body[0];
    let fmt = std::str::from_utf8(&body[1..4])
        .unwrap_or("")
        .to_ascii_uppercase();
    let pic_type = body[4];
    let after_desc = skip_encoded_string(body, 5, encoding)?;
    if after_desc >= body.len() {
        return None;
    }
    let img_bytes = &body[after_desc..];
    let declared = if fmt == "PNG" {
        "image/png"
    } else {
        "image/jpeg"
    };
    let mime_type = sniff_image_mime(img_bytes, declared)?;
    Some(ExtractedArtwork {
        bytes: img_bytes.to_vec(),
        mime_type,
        picture_type: pic_type,
    })
}

fn parse_id3_apic(body: &[u8], flags: u16, major_version: u8) -> Option<ExtractedArtwork> {
    let mut slice = body;
    // Handle ID3v2.4 data length indicator (flag 0x0001 in second flag byte)
    if major_version == 4 && (flags & 0x0001) != 0 {
        if slice.len() < 4 {
            return None;
        }
        slice = &slice[4..];
    }
    if slice.len() < 4 {
        return None;
    }
    let encoding = slice[0];
    let mut mime_end = 1;
    while mime_end < slice.len() && slice[mime_end] != 0 {
        mime_end += 1;
    }
    if mime_end >= slice.len() {
        return None;
    }
    let raw_mime = String::from_utf8_lossy(&slice[1..mime_end])
        .trim()
        .to_string();
    let pos = mime_end + 1;
    if pos >= slice.len() {
        return None;
    }
    let pic_type = slice[pos];
    let after_desc = skip_encoded_string(slice, pos + 1, encoding)?;
    if after_desc >= slice.len() {
        return None;
    }
    let img_bytes = &slice[after_desc..];
    let mime_type = sniff_image_mime(img_bytes, &raw_mime)?;
    Some(ExtractedArtwork {
        bytes: img_bytes.to_vec(),
        mime_type,
        picture_type: pic_type,
    })
}

fn extract_from_id3v2(file: &mut File, file_len: u64) -> Result<Option<ExtractedArtwork>, String> {
    if file_len < 10 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut header = [0u8; 10];
    if file.read_exact(&mut header).is_err() {
        return Ok(None);
    }
    if &header[0..3] != b"ID3" {
        return Ok(None);
    }
    let major = header[3];
    if major != 2 && major != 3 && major != 4 {
        return Ok(None);
    }
    let flags = header[5];
    let tag_size = syncsafe_u32(&header[6..10]);
    if tag_size == 0 {
        return Ok(None);
    }
    let to_read = tag_size.min(ID3_SCAN_LIMIT).min((file_len - 10) as usize);
    let mut buf = vec![0u8; to_read];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;

    let mut offset = 0usize;
    if (flags & 0x40) != 0 {
        if offset + 4 > buf.len() {
            return Ok(None);
        }
        let ext_size = if major == 4 {
            syncsafe_u32(&buf[offset..offset + 4])
        } else {
            4 + u32::from_be_bytes([
                buf[offset],
                buf[offset + 1],
                buf[offset + 2],
                buf[offset + 3],
            ]) as usize
        };
        offset = offset.saturating_add(ext_size);
    }

    let mut fallback_art: Option<ExtractedArtwork> = None;

    if major == 2 {
        while offset + 6 <= buf.len() {
            let id = &buf[offset..offset + 3];
            if !id
                .iter()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                break;
            }
            let size = ((buf[offset + 3] as usize) << 16)
                | ((buf[offset + 4] as usize) << 8)
                | (buf[offset + 5] as usize);
            if size == 0 || offset + 6 + size > buf.len() {
                break;
            }
            if id == b"PIC" {
                let body = &buf[offset + 6..offset + 6 + size];
                if let Some(art) = parse_id3_pic2(body) {
                    if art.picture_type == 3 {
                        return Ok(Some(art));
                    }
                    if fallback_art.is_none() {
                        fallback_art = Some(art);
                    }
                }
            }
            offset += 6 + size;
        }
        return Ok(fallback_art);
    }

    while offset + 10 <= buf.len() {
        let id = &buf[offset..offset + 4];
        if !id
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            break;
        }
        let size = if major == 4 {
            syncsafe_u32(&buf[offset + 4..offset + 8])
        } else {
            u32::from_be_bytes([
                buf[offset + 4],
                buf[offset + 5],
                buf[offset + 6],
                buf[offset + 7],
            ]) as usize
        };
        let frame_flags = u16::from_be_bytes([buf[offset + 8], buf[offset + 9]]);
        if size == 0 || offset + 10 + size > buf.len() {
            break;
        }
        if id == b"APIC" {
            let body = &buf[offset + 10..offset + 10 + size];
            if let Some(art) = parse_id3_apic(body, frame_flags, major) {
                if art.picture_type == 3 {
                    return Ok(Some(art));
                }
                if fallback_art.is_none() {
                    fallback_art = Some(art);
                }
            }
        }
        offset += 10 + size;
    }

    Ok(fallback_art)
}

pub fn parse_flac_picture_bytes(data: &[u8]) -> Option<ExtractedArtwork> {
    if data.len() < 32 {
        return None;
    }
    let pic_type = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as u8;
    let mime_len = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let mut pos = 8usize;
    if pos.checked_add(mime_len)? + 4 > data.len() {
        return None;
    }
    let raw_mime = String::from_utf8_lossy(&data[pos..pos + mime_len])
        .trim()
        .to_string();
    pos += mime_len;
    let desc_len =
        u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
    pos = pos.checked_add(4)?.checked_add(desc_len)?.checked_add(16)?;
    if pos + 4 > data.len() {
        return None;
    }
    let img_len =
        u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
    pos += 4;
    if !(MIN_EMBEDDED_ARTWORK_BYTES..=MAX_EMBEDDED_ARTWORK_BYTES).contains(&img_len)
        || pos.checked_add(img_len)? > data.len()
    {
        return None;
    }
    let img_bytes = &data[pos..pos + img_len];
    let mime_type = sniff_image_mime(img_bytes, &raw_mime)?;
    Some(ExtractedArtwork {
        bytes: img_bytes.to_vec(),
        mime_type,
        picture_type: pic_type,
    })
}

fn extract_from_flac(file: &mut File, file_len: u64) -> Result<Option<ExtractedArtwork>, String> {
    if file_len < 8 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).is_err() || &magic != b"fLaC" {
        return Ok(None);
    }
    let mut offset = 4u64;
    let mut fallback_art: Option<ExtractedArtwork> = None;

    for _ in 0..128 {
        if offset + 4 > file_len {
            break;
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut hdr = [0u8; 4];
        if file.read_exact(&mut hdr).is_err() {
            break;
        }
        let is_last = (hdr[0] & 0x80) != 0;
        let block_type = hdr[0] & 0x7f;
        let block_len =
            (((hdr[1] as u64) << 16) | ((hdr[2] as u64) << 8) | (hdr[3] as u64)) as usize;
        let data_start = offset + 4;
        if data_start + (block_len as u64) > file_len {
            break;
        }
        if block_type == 6 && (32..=MAX_EMBEDDED_ARTWORK_BYTES + 65536).contains(&block_len) {
            let mut block_buf = vec![0u8; block_len];
            if file.read_exact(&mut block_buf).is_ok() {
                if let Some(art) = parse_flac_picture_bytes(&block_buf) {
                    if art.picture_type == 3 {
                        return Ok(Some(art));
                    }
                    if fallback_art.is_none() {
                        fallback_art = Some(art);
                    }
                }
            }
        }
        offset = data_start + (block_len as u64);
        if is_last {
            break;
        }
    }
    Ok(fallback_art)
}

fn parse_mp4_buffer(buf: &[u8]) -> Option<ExtractedArtwork> {
    fn read_atom(slice: &[u8], offset: usize) -> Option<(usize, &[u8; 4], usize)> {
        if offset + 8 > slice.len() {
            return None;
        }
        let size32 = u32::from_be_bytes([
            slice[offset],
            slice[offset + 1],
            slice[offset + 2],
            slice[offset + 3],
        ]) as usize;
        let kind: &[u8; 4] = slice[offset + 4..offset + 8].try_into().ok()?;
        if size32 == 1 {
            if offset + 16 > slice.len() {
                return None;
            }
            let size64 =
                u64::from_be_bytes(slice[offset + 8..offset + 16].try_into().ok()?) as usize;
            if size64 < 16 {
                return None;
            }
            Some((size64, kind, offset + 16))
        } else if size32 == 0 {
            Some((slice.len() - offset, kind, offset + 8))
        } else if size32 >= 8 {
            Some((size32, kind, offset + 8))
        } else {
            None
        }
    }

    // Locate moov atom
    let mut moov_range: Option<(usize, usize)> = None;
    let mut top = 0usize;
    while let Some((size, kind, content_start)) = read_atom(buf, top) {
        let end = (top + size).min(buf.len());
        if end <= content_start {
            break;
        }
        if kind == b"moov" {
            moov_range = Some((content_start, end));
            break;
        }
        top = end;
    }
    if moov_range.is_none() {
        for i in 0..buf.len().saturating_sub(8) {
            if &buf[i + 4..i + 8] == b"moov" {
                if let Some((size, _, content_start)) = read_atom(buf, i) {
                    let end = (i + size).min(buf.len());
                    if end > content_start {
                        moov_range = Some((content_start, end));
                        break;
                    }
                }
            }
        }
    }
    let (moov_start, moov_end) = moov_range?;

    let mut o1 = moov_start;
    while let Some((s1, k1, c1)) = read_atom(buf, o1) {
        let e1 = (o1 + s1).min(moov_end);
        if e1 <= c1 {
            break;
        }
        if k1 == b"udta" {
            let mut o2 = c1;
            while let Some((s2, k2, c2)) = read_atom(buf, o2) {
                let e2 = (o2 + s2).min(e1);
                if e2 <= c2 {
                    break;
                }
                if k2 == b"meta" && c2 + 4 <= e2 {
                    let mut o3 = c2 + 4;
                    while let Some((s3, k3, c3)) = read_atom(buf, o3) {
                        let e3 = (o3 + s3).min(e2);
                        if e3 <= c3 {
                            break;
                        }
                        if k3 == b"ilst" {
                            let mut o4 = c3;
                            while let Some((s4, k4, c4)) = read_atom(buf, o4) {
                                let e4 = (o4 + s4).min(e3);
                                if e4 <= c4 {
                                    break;
                                }
                                if k4 == b"covr" {
                                    let mut o5 = c4;
                                    while let Some((s5, k5, c5)) = read_atom(buf, o5) {
                                        let e5 = (o5 + s5).min(e4);
                                        if e5 <= c5 {
                                            break;
                                        }
                                        if k5 == b"data" && c5 + 8 <= e5 {
                                            let dtype = u32::from_be_bytes([
                                                buf[c5],
                                                buf[c5 + 1],
                                                buf[c5 + 2],
                                                buf[c5 + 3],
                                            ]);
                                            let img_bytes = &buf[c5 + 8..e5];
                                            let declared = if dtype == 14 {
                                                "image/png"
                                            } else {
                                                "image/jpeg"
                                            };
                                            if let Some(mime_type) =
                                                sniff_image_mime(img_bytes, declared)
                                            {
                                                return Some(ExtractedArtwork {
                                                    bytes: img_bytes.to_vec(),
                                                    mime_type,
                                                    picture_type: 3,
                                                });
                                            }
                                        }
                                        o5 = e5;
                                    }
                                }
                                o4 = e4;
                            }
                        }
                        o3 = e3;
                    }
                }
                o2 = e2;
            }
        }
        o1 = e1;
    }
    None
}

fn extract_from_mp4(file: &mut File, file_len: u64) -> Result<Option<ExtractedArtwork>, String> {
    if file_len < 16 {
        return Ok(None);
    }
    let head_len = (file_len as usize).min(MP4_SCAN_LIMIT);
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head).map_err(|e| e.to_string())?;
    if let Some(art) = parse_mp4_buffer(&head) {
        return Ok(Some(art));
    }
    if file_len > MP4_SCAN_LIMIT as u64 {
        let tail_offset = file_len - (MP4_SCAN_LIMIT as u64);
        file.seek(SeekFrom::Start(tail_offset))
            .map_err(|e| e.to_string())?;
        let mut tail = vec![0u8; MP4_SCAN_LIMIT];
        file.read_exact(&mut tail).map_err(|e| e.to_string())?;
        if let Some(art) = parse_mp4_buffer(&tail) {
            return Ok(Some(art));
        }
    }
    Ok(None)
}

fn parse_vorbis_comment_artwork(payload: &[u8]) -> Option<ExtractedArtwork> {
    let mut pos = if payload.len() > 7 && payload[0] == 0x03 && &payload[1..7] == b"vorbis" {
        7usize
    } else if payload.len() > 8 && &payload[0..8] == b"OpusTags" {
        8usize
    } else {
        return None;
    };
    if pos + 4 > payload.len() {
        return None;
    }
    let vendor_len = u32::from_le_bytes([
        payload[pos],
        payload[pos + 1],
        payload[pos + 2],
        payload[pos + 3],
    ]) as usize;
    pos = pos.checked_add(4)?.checked_add(vendor_len)?;
    if pos + 4 > payload.len() {
        return None;
    }
    let count = u32::from_le_bytes([
        payload[pos],
        payload[pos + 1],
        payload[pos + 2],
        payload[pos + 3],
    ]) as usize;
    pos += 4;

    let mut fallback_art: Option<ExtractedArtwork> = None;
    for _ in 0..count.min(256) {
        if pos + 4 > payload.len() {
            break;
        }
        let len = u32::from_le_bytes([
            payload[pos],
            payload[pos + 1],
            payload[pos + 2],
            payload[pos + 3],
        ]) as usize;
        pos += 4;
        if pos.checked_add(len)? > payload.len() {
            break;
        }
        let raw_comment = &payload[pos..pos + len];
        pos += len;
        if let Some(eq_idx) = raw_comment.iter().position(|&b| b == b'=') {
            let key = String::from_utf8_lossy(&raw_comment[..eq_idx]).to_ascii_uppercase();
            let val = &raw_comment[eq_idx + 1..];
            if key == "METADATA_BLOCK_PICTURE" && val.len() <= MAX_EMBEDDED_ARTWORK_BYTES * 2 {
                let cleaned: Vec<u8> = val
                    .iter()
                    .copied()
                    .filter(|b| !b.is_ascii_whitespace())
                    .collect();
                if let Ok(decoded) = STANDARD.decode(&cleaned) {
                    if let Some(art) = parse_flac_picture_bytes(&decoded) {
                        if art.picture_type == 3 {
                            return Some(art);
                        }
                        if fallback_art.is_none() {
                            fallback_art = Some(art);
                        }
                    }
                }
            } else if key == "COVERART" && val.len() <= MAX_EMBEDDED_ARTWORK_BYTES * 2 {
                let cleaned: Vec<u8> = val
                    .iter()
                    .copied()
                    .filter(|b| !b.is_ascii_whitespace())
                    .collect();
                if let Ok(decoded) = STANDARD.decode(&cleaned) {
                    if let Some(mime_type) = sniff_image_mime(&decoded, "image/jpeg") {
                        if fallback_art.is_none() {
                            fallback_art = Some(ExtractedArtwork {
                                bytes: decoded,
                                mime_type,
                                picture_type: 3,
                            });
                        }
                    }
                }
            }
        }
    }
    fallback_art
}

fn extract_from_ogg(file: &mut File, file_len: u64) -> Result<Option<ExtractedArtwork>, String> {
    if file_len < 28 {
        return Ok(None);
    }
    let scan_len = (file_len as usize).min(OGG_SCAN_LIMIT);
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut data = vec![0u8; scan_len];
    file.read_exact(&mut data).map_err(|e| e.to_string())?;

    // Reassemble Ogg packets across continuation pages so large METADATA_BLOCK_PICTURE tags succeed
    let mut cursor = 0usize;
    let mut packet = Vec::new();
    while cursor + 27 <= data.len() {
        let Some(rel) = data[cursor..].windows(4).position(|w| w == b"OggS") else {
            break;
        };
        let page_start = cursor + rel;
        if page_start + 27 > data.len() {
            break;
        }
        let header_type = data[page_start + 5];
        let is_continued = (header_type & 0x01) != 0;
        if !is_continued && !packet.is_empty() {
            if let Some(art) = parse_vorbis_comment_artwork(&packet) {
                return Ok(Some(art));
            }
            packet.clear();
        }
        let seg_count = data[page_start + 26] as usize;
        let seg_table_start = page_start + 27;
        if seg_table_start + seg_count > data.len() {
            break;
        }
        let segs = &data[seg_table_start..seg_table_start + seg_count];
        let mut body_cursor = seg_table_start + seg_count;
        for &seg_len in segs {
            let sl = seg_len as usize;
            if body_cursor + sl > data.len() {
                break;
            }
            if packet.len() + sl <= MAX_EMBEDDED_ARTWORK_BYTES * 2 {
                packet.extend_from_slice(&data[body_cursor..body_cursor + sl]);
            }
            body_cursor += sl;
            if seg_len < 255 {
                if let Some(art) = parse_vorbis_comment_artwork(&packet) {
                    return Ok(Some(art));
                }
                packet.clear();
            }
        }
        cursor = body_cursor;
    }
    if !packet.is_empty() {
        if let Some(art) = parse_vorbis_comment_artwork(&packet) {
            return Ok(Some(art));
        }
    }
    Ok(None)
}

pub fn extract_embedded_artwork(path: &Path) -> Result<Option<ExtractedArtwork>, String> {
    let mut file = File::open(path)
        .map_err(|e| format!("Could not open audio file {}: {e}", path.display()))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("Could not read metadata for {}: {e}", path.display()))?
        .len();
    if file_len < 16 {
        return Ok(None);
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    let mut head = [0u8; 12];
    let _ = file.read(&mut head);

    if &head[0..4] == b"fLaC" || ext == "flac" {
        if let Some(art) = extract_from_flac(&mut file, file_len)? {
            return Ok(Some(art));
        }
    }
    if &head[0..4] == b"OggS" || matches!(ext.as_str(), "ogg" | "oga" | "opus") {
        if let Some(art) = extract_from_ogg(&mut file, file_len)? {
            return Ok(Some(art));
        }
    }
    if &head[0..3] == b"ID3" || ext == "mp3" {
        if let Some(art) = extract_from_id3v2(&mut file, file_len)? {
            return Ok(Some(art));
        }
    }
    if &head[4..8] == b"ftyp" || matches!(ext.as_str(), "m4a" | "m4b" | "mp4" | "aac") {
        if let Some(art) = extract_from_mp4(&mut file, file_len)? {
            return Ok(Some(art));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::fs;
    use std::io::Cursor;

    fn sample_png_bytes() -> Vec<u8> {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(32, 32, |x, y| {
            Rgba([(x * 8) as u8, (y * 8) as u8, 128, 255])
        });
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        buf
    }

    fn build_id3v23_with_apic(mime: &str, pic_type: u8, desc: &[u8], img: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        body.push(0); // Latin-1 encoding
        body.extend_from_slice(mime.as_bytes());
        body.push(0);
        body.push(pic_type);
        body.extend_from_slice(desc);
        body.push(0);
        body.extend_from_slice(img);

        let size = body.len() as u32;
        let mut frame = Vec::new();
        frame.extend_from_slice(b"APIC");
        frame.extend_from_slice(&size.to_be_bytes());
        frame.extend_from_slice(&[0, 0]);
        frame.extend_from_slice(&body);

        let tag_len = frame.len() as u32;
        let syncsafe = [
            ((tag_len >> 21) & 0x7f) as u8,
            ((tag_len >> 14) & 0x7f) as u8,
            ((tag_len >> 7) & 0x7f) as u8,
            (tag_len & 0x7f) as u8,
        ];
        let mut mp3 = Vec::new();
        mp3.extend_from_slice(b"ID3\x03\x00\x00");
        mp3.extend_from_slice(&syncsafe);
        mp3.extend_from_slice(&frame);
        mp3.extend_from_slice(&[0xff, 0xfb, 0x90, 0x64]); // fake audio frame
        mp3
    }

    fn build_flac_picture_block(pic_type: u32, mime: &str, desc: &[u8], img: &[u8]) -> Vec<u8> {
        let mut block = Vec::new();
        block.extend_from_slice(&pic_type.to_be_bytes());
        block.extend_from_slice(&(mime.len() as u32).to_be_bytes());
        block.extend_from_slice(mime.as_bytes());
        block.extend_from_slice(&(desc.len() as u32).to_be_bytes());
        block.extend_from_slice(desc);
        block.extend_from_slice(&32u32.to_be_bytes()); // width
        block.extend_from_slice(&32u32.to_be_bytes()); // height
        block.extend_from_slice(&32u32.to_be_bytes()); // depth
        block.extend_from_slice(&0u32.to_be_bytes()); // colors
        block.extend_from_slice(&(img.len() as u32).to_be_bytes());
        block.extend_from_slice(img);
        block
    }

    fn build_flac_file(pic_block: &[u8]) -> Vec<u8> {
        let mut flac = Vec::new();
        flac.extend_from_slice(b"fLaC");
        let len = pic_block.len() as u32;
        flac.push(0x80 | 6); // is_last = 1, type = 6 (PICTURE)
        flac.push(((len >> 16) & 0xff) as u8);
        flac.push(((len >> 8) & 0xff) as u8);
        flac.push((len & 0xff) as u8);
        flac.extend_from_slice(pic_block);
        flac
    }

    fn build_mp4_with_covr(data_type: u32, img: &[u8]) -> Vec<u8> {
        fn atom(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let size = (8 + payload.len()) as u32;
            let mut out = Vec::with_capacity(size as usize);
            out.extend_from_slice(&size.to_be_bytes());
            out.extend_from_slice(name);
            out.extend_from_slice(payload);
            out
        }
        let mut data_payload = Vec::new();
        data_payload.extend_from_slice(&data_type.to_be_bytes());
        data_payload.extend_from_slice(&0u32.to_be_bytes());
        data_payload.extend_from_slice(img);
        let data_atom = atom(b"data", &data_payload);
        let covr_atom = atom(b"covr", &data_atom);
        let ilst_atom = atom(b"ilst", &covr_atom);
        let mut meta_payload = vec![0, 0, 0, 0];
        meta_payload.extend_from_slice(&ilst_atom);
        let meta_atom = atom(b"meta", &meta_payload);
        let udta_atom = atom(b"udta", &meta_atom);
        let moov_atom = atom(b"moov", &udta_atom);
        let ftyp_atom = atom(b"ftyp", b"M4A \x00\x00\x00\x00");
        let mut file = Vec::new();
        file.extend_from_slice(&ftyp_atom);
        file.extend_from_slice(&moov_atom);
        file
    }

    fn build_ogg_with_picture(pic_block: &[u8]) -> Vec<u8> {
        let b64 = STANDARD.encode(pic_block);
        let comment = format!("METADATA_BLOCK_PICTURE={b64}");
        let mut payload = Vec::new();
        payload.extend_from_slice(b"OpusTags");
        let vendor = b"GmusicTest";
        payload.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        payload.extend_from_slice(vendor);
        payload.extend_from_slice(&1u32.to_le_bytes());
        payload.extend_from_slice(&(comment.len() as u32).to_le_bytes());
        payload.extend_from_slice(comment.as_bytes());

        let mut segments = Vec::new();
        let mut remaining = payload.len();
        while remaining >= 255 {
            segments.push(255u8);
            remaining -= 255;
        }
        segments.push(remaining as u8);

        let mut page = Vec::new();
        page.extend_from_slice(b"OggS");
        page.push(0);
        page.push(0);
        page.extend_from_slice(&0u64.to_le_bytes());
        page.extend_from_slice(&1u32.to_le_bytes());
        page.extend_from_slice(&1u32.to_le_bytes());
        page.extend_from_slice(&0u32.to_le_bytes());
        page.push(segments.len() as u8);
        page.extend_from_slice(&segments);
        page.extend_from_slice(&payload);
        page
    }

    #[test]
    fn extracts_embedded_artwork_from_mp3_flac_m4a_and_ogg() {
        let dir = tempfile::tempdir().unwrap();
        let png = sample_png_bytes();

        // 1. MP3 ID3v2.3 APIC
        let mp3_path = dir.path().join("song.mp3");
        fs::write(
            &mp3_path,
            build_id3v23_with_apic("image/png", 3, b"Cover", &png),
        )
        .unwrap();
        let mp3_art = extract_embedded_artwork(&mp3_path).unwrap().unwrap();
        assert_eq!(mp3_art.bytes, png);
        assert_eq!(mp3_art.mime_type, "image/png");
        assert_eq!(mp3_art.picture_type, 3);

        // 2. FLAC PICTURE block (including >1KB description)
        let flac_path = dir.path().join("song.flac");
        let pic_block = build_flac_picture_block(3, "image/png", &vec![b'A'; 1500], &png);
        fs::write(&flac_path, build_flac_file(&pic_block)).unwrap();
        let flac_art = extract_embedded_artwork(&flac_path).unwrap().unwrap();
        assert_eq!(flac_art.bytes, png);
        assert_eq!(flac_art.mime_type, "image/png");

        // 3. M4A covr atom
        let m4a_path = dir.path().join("song.m4a");
        fs::write(&m4a_path, build_mp4_with_covr(14, &png)).unwrap();
        let m4a_art = extract_embedded_artwork(&m4a_path).unwrap().unwrap();
        assert_eq!(m4a_art.bytes, png);
        assert_eq!(m4a_art.mime_type, "image/png");

        // 4. OGG/Opus METADATA_BLOCK_PICTURE
        let ogg_path = dir.path().join("song.opus");
        fs::write(&ogg_path, build_ogg_with_picture(&pic_block)).unwrap();
        let ogg_art = extract_embedded_artwork(&ogg_path).unwrap().unwrap();
        assert_eq!(ogg_art.bytes, png);
        assert_eq!(ogg_art.mime_type, "image/png");
    }

    #[test]
    fn safely_handles_missing_malformed_and_oversized_embedded_artwork() {
        let dir = tempfile::tempdir().unwrap();

        // Missing artwork (plain WAV/MP3 without picture)
        let wav_path = dir.path().join("plain.wav");
        fs::write(&wav_path, b"RIFF\x24\x00\x00\x00WAVEfmt ").unwrap();
        assert!(extract_embedded_artwork(&wav_path).unwrap().is_none());

        // Undersized / malformed APIC (< 64 bytes)
        let tiny_mp3 = dir.path().join("tiny.mp3");
        fs::write(
            &tiny_mp3,
            build_id3v23_with_apic("image/jpeg", 3, b"", &[0xff, 0xd8, 0xff]),
        )
        .unwrap();
        assert!(extract_embedded_artwork(&tiny_mp3).unwrap().is_none());

        // Truncated FLAC header claiming huge block size
        let bad_flac = dir.path().join("bad.flac");
        fs::write(&bad_flac, b"fLaC\x86\xff\xff\xff\x00\x00\x00\x03").unwrap();
        assert!(extract_embedded_artwork(&bad_flac).unwrap().is_none());
    }
}
