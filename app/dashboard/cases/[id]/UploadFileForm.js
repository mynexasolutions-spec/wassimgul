'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function UploadFileForm({ caseId, caseNumber }) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState(null);
  const formRef = useRef(null);
  const router = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    const form = formRef.current;
    if (!form) return;

    const fileInput = form.querySelector('input[type="file"]');
    const file = fileInput?.files?.[0];

    if (!file) {
      setError('Please select an image or PDF file to upload.');
      return;
    }

    const fileName = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || fileName.endsWith('.pdf');
    const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|svg|bmp)$/i.test(fileName);

    if (!isPdf && !isImage) {
      setError('Only image files (JPG, PNG, WebP, GIF, SVG) and PDF files can be uploaded.');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setError('File is too large (25MB maximum limit).');
      return;
    }

    setUploading(true);
    setProgress(0);
    setStatusText('Uploading simultaneously…');

    try {
      const formData = new FormData();
      formData.append('caseId', caseId);
      formData.append('caseNumber', caseNumber || '');
      formData.append('file', file);

      // Upload to dual-storage API route with live progress tracking
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/cases/upload');

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setProgress(percent);
            if (percent >= 100) {
              setStatusText('Processing storage & syncing providers…');
            } else {
              setStatusText(`Uploading ${percent}%…`);
            }
          }
        };

        xhr.onload = () => {
          try {
            const response = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300 && response.success) {
              resolve(response);
            } else {
              reject(new Error(response.error || response.message || 'Dual upload failed.'));
            }
          } catch (parseErr) {
            reject(new Error('Invalid response from upload server.'));
          }
        };

        xhr.onerror = () => {
          reject(new Error('Network error during file upload.'));
        };

        xhr.send(formData);
      });

      // Done! Reset form and refresh server state
      form.reset();
      setProgress(0);
      setStatusText('');
      setUploading(false);
      router.refresh();
    } catch (err) {
      console.error('Upload process error:', err);
      setError(err.message || 'Upload failed. Please try again.');
      setUploading(false);
      setProgress(0);
      setStatusText('');
    }
  }

  return (
    <form onSubmit={handleSubmit} ref={formRef} className="dash-form">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="caseNumber" value={caseNumber || ''} />
      <div className="upload-row">
        <div className="f">
          <label htmlFor="file">Upload Case File (PDF or Image, up to 25MB)</label>
          <input
            id="file"
            name="file"
            type="file"
            accept="application/pdf,image/*,.pdf,.jpg,.jpeg,.png,.webp,.gif,.svg"
            required
            disabled={uploading}
          />
        </div>
        <button type="submit" className="btn btn-outline" disabled={uploading}>
          {uploading ? (statusText || 'Uploading…') : 'Upload'}
        </button>
      </div>
      {error && <p className="dash-field-error" role="alert">{error}</p>}
    </form>
  );
}

