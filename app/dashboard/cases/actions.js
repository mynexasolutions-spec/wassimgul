'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireAuth, requireAdmin } from '@/lib/supabase/dal';
import { logActivity } from '@/lib/supabase/activity';
import {
  uploadFileDual,
  deleteFileFromStorage,
  deleteCaseStorage,
  isAllowedFileType,
  MAX_FILE_BYTES,
} from '@/lib/storage';


// Data now surfaces in several places at once — revalidate them all together.
function revalidateDashboardPaths(caseId) {
  revalidatePath('/dashboard');
  revalidatePath('/dashboard/cases');
  revalidatePath('/dashboard/orders');
  revalidatePath('/dashboard/notes');
  revalidatePath('/dashboard/case-files');
  revalidatePath('/dashboard/activity');
  if (caseId) revalidatePath(`/dashboard/cases/${caseId}`);
}

// The forms that call these actions already know the case number (it's
// rendered on the page) — passing it through a hidden field avoids an extra
// DB round-trip on every single mutation just to build a log description.
async function resolveCaseNumber(supabase, formData, caseId) {
  const fromForm = String(formData.get('caseNumber') || '').trim();
  if (fromForm) return fromForm;
  const { data } = await supabase.from('cases').select('case_number').eq('id', caseId).single();
  return data?.case_number || 'a case';
}

// ---------- Cases ----------

export async function createCase(prevState, formData) {
  const profile = await requireAdmin();

  const caseNumber = String(formData.get('caseNumber') || '').trim();
  const title = String(formData.get('title') || '').trim() || null;
  const court = String(formData.get('court') || '').trim() || null;
  const clientName = String(formData.get('clientName') || '').trim();
  const status = String(formData.get('status') || 'active');
  const description = String(formData.get('description') || '').trim() || null;

  if (!caseNumber || !clientName) {
    return { error: 'Case number and client name are required.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('cases')
    .insert({ case_number: caseNumber, title, court, client_name: clientName, status, description, created_by: profile.id })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { error: 'A case with that case number already exists.' };
    }
    return { error: 'Could not create the case. Please try again.' };
  }

  await logActivity(supabase, {
    actorId: profile.id,
    action: 'case_created',
    caseId: data.id,
    description: `${profile.fullName || profile.email} created case ${caseNumber}`,
  });

  revalidateDashboardPaths();
  redirect(`/dashboard/cases/${data.id}`);
}

export async function updateCase(prevState, formData) {
  const profile = await requireAdmin();

  const id = String(formData.get('id') || '');
  const caseNumber = String(formData.get('caseNumber') || '').trim();
  const title = String(formData.get('title') || '').trim() || null;
  const court = String(formData.get('court') || '').trim() || null;
  const clientName = String(formData.get('clientName') || '').trim();
  const status = String(formData.get('status') || 'active');
  const description = String(formData.get('description') || '').trim() || null;

  if (!id || !caseNumber || !clientName) {
    return { error: 'Case number and client name are required.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('cases')
    .update({ case_number: caseNumber, title, court, client_name: clientName, status, description, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    if (error.code === '23505') {
      return { error: 'A case with that case number already exists.' };
    }
    return { error: 'Could not save changes. Please try again.' };
  }

  await logActivity(supabase, {
    actorId: profile.id,
    action: 'case_updated',
    caseId: id,
    description: `${profile.fullName || profile.email} updated case ${caseNumber}`,
  });

  revalidateDashboardPaths(id);
  redirect(`/dashboard/cases/${id}`);
}

export async function deleteCase(formData) {
  const profile = await requireAdmin();
  const id = String(formData.get('id') || '');
  if (!id) return;

  const supabase = await createClient();
  const caseNumber = await resolveCaseNumber(supabase, formData, id);

  // Clean up any files across dual storage (Cloudinary & ImageKit)
  try {
    const { data: caseFiles } = await supabase.from('case_files').select('storage_path').eq('case_id', id);
    await deleteCaseStorage(id, caseFiles || []);
  } catch (err) {
    console.error('Case storage cleanup error:', err);
  }

  // Legacy Supabase storage cleanup if present
  try {
    const { data: files } = await supabase.storage.from('case-files').list(id);
    if (files?.length) {
      await supabase.storage.from('case-files').remove(files.map((f) => `${id}/${f.name}`));
    }
  } catch (_) {}

  await supabase.from('cases').delete().eq('id', id);

  await logActivity(supabase, {
    actorId: profile.id,
    action: 'case_deleted',
    caseId: null,
    description: `${profile.fullName || profile.email} deleted case ${caseNumber}`,
  });

  revalidateDashboardPaths();
  redirect('/dashboard');
}

// ---------- Case files ----------

export async function uploadCaseFile(prevState, formData) {
  const profile = await requireAdmin();
  const caseId = String(formData.get('caseId') || '');
  const file = formData.get('file');

  if (!caseId || !(file instanceof File) || file.size === 0) {
    return { error: 'Please choose an image or PDF file to upload.' };
  }
  if (!isAllowedFileType(file)) {
    return { error: 'Only image (JPG, PNG, WebP, GIF, SVG) and PDF files can be uploaded.' };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { error: 'File is too large (25MB max).' };
  }

  const supabase = await createClient();

  // Resolve case details for meaningful human-readable folder naming in Google Drive
  let folderDisplayName = '';
  const { data: caseRow } = await supabase
    .from('cases')
    .select('case_number, client_name, title')
    .eq('id', caseId)
    .maybeSingle();

  if (caseRow) {
    if (caseRow.case_number && caseRow.client_name) {
      folderDisplayName = `Case ${caseRow.case_number} - ${caseRow.client_name}`;
    } else if (caseRow.case_number) {
      folderDisplayName = `Case ${caseRow.case_number}`;
    } else if (caseRow.client_name) {
      folderDisplayName = `Client ${caseRow.client_name}`;
    } else if (caseRow.title) {
      folderDisplayName = caseRow.title;
    }
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  let uploadResult;
  try {
    uploadResult = await uploadFileDual(fileBuffer, {
      fileName: file.name,
      mimeType: file.type,
      caseId,
      folderName: folderDisplayName,
    });
  } catch (uploadError) {
    console.error('Dual upload error in action:', uploadError);
    return { error: uploadError?.message || 'Upload failed. Please try again.' };
  }

  if (!uploadResult || !uploadResult.primaryUrl) {
    return { error: 'Upload failed. Please try again.' };
  }
  const { error: insertError } = await supabase.from('case_files').insert({
    case_id: caseId,
    file_name: file.name,
    storage_path: uploadResult.storagePayload,
    file_size: file.size,
    uploaded_by: profile.id,
  });

  if (insertError) {
    console.error('DB insert error:', insertError);
    try {
      await deleteFileFromStorage(uploadResult.storagePayload);
    } catch (_) {}
    return { error: 'Could not save the file record. Please try again.' };
  }

  const caseNumber = await resolveCaseNumber(supabase, formData, caseId);
  await logActivity(supabase, {
    actorId: profile.id,
    action: 'file_uploaded',
    caseId,
    description: `${profile.fullName || profile.email} uploaded a file in ${caseNumber}`,
  });

  revalidateDashboardPaths(caseId);
  return { success: true };
}

export async function deleteCaseFile(formData) {
  const profile = await requireAdmin();
  const fileId = String(formData.get('fileId') || '');
  const storagePath = String(formData.get('storagePath') || '');
  const caseId = String(formData.get('caseId') || '');
  if (!fileId) return;

  if (storagePath) {
    try {
      await deleteFileFromStorage(storagePath);
    } catch (err) {
      console.error('Error deleting file from storage:', err);
    }

    if (!storagePath.startsWith('{') && !storagePath.startsWith('http')) {
      // Legacy Supabase storage fallback
      try {
        const supabase = await createClient();
        await supabase.storage.from('case-files').remove([storagePath]);
      } catch (_) {}
    }
  }

  const supabase = await createClient();
  await supabase.from('case_files').delete().eq('id', fileId);


  const caseNumber = await resolveCaseNumber(supabase, formData, caseId);
  await logActivity(supabase, {
    actorId: profile.id,
    action: 'file_deleted',
    caseId,
    description: `${profile.fullName || profile.email} deleted a file in ${caseNumber}`,
  });

  revalidateDashboardPaths(caseId);
}

// ---------- Daily Orders & Notes (unified timeline) ----------

export async function addCaseUpdate(prevState, formData) {
  const profile = await requireAuth();

  const caseId = String(formData.get('caseId') || '');
  const type = String(formData.get('type') || 'note');
  const content = String(formData.get('content') || '').trim();
  const entryDate = String(formData.get('entryDate') || '') || undefined;

  if (!caseId || !content || !['order', 'note'].includes(type)) {
    return { error: 'Please choose a case and type, and enter some content.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.from('case_updates').insert({
    case_id: caseId,
    type,
    content,
    entry_date: entryDate,
    created_by: profile.id,
  });

  if (error) {
    return { error: 'Could not save that entry. Please try again.' };
  }

  const caseNumber = await resolveCaseNumber(supabase, formData,caseId);
  await logActivity(supabase, {
    actorId: profile.id,
    action: type === 'order' ? 'order_added' : 'note_added',
    caseId,
    description: `${profile.fullName || profile.email} added a ${type === 'order' ? 'daily order' : 'note'} in ${caseNumber}`,
  });

  revalidateDashboardPaths(caseId);
  return { success: true };
}

export async function updateCaseUpdate(prevState, formData) {
  const profile = await requireAdmin();

  const id = String(formData.get('id') || '');
  const caseId = String(formData.get('caseId') || '');
  const type = String(formData.get('type') || 'note');
  const content = String(formData.get('content') || '').trim();
  const entryDate = String(formData.get('entryDate') || '') || undefined;

  if (!id || !content) {
    return { error: 'Content cannot be empty.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('case_updates')
    .update({ type, content, entry_date: entryDate, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    return { error: 'Could not save changes. Please try again.' };
  }

  const caseNumber = await resolveCaseNumber(supabase, formData,caseId);
  await logActivity(supabase, {
    actorId: profile.id,
    action: type === 'order' ? 'order_updated' : 'note_updated',
    caseId,
    description: `${profile.fullName || profile.email} updated a ${type === 'order' ? 'daily order' : 'note'} in ${caseNumber}`,
  });

  revalidateDashboardPaths(caseId);
  return { success: true };
}

export async function deleteCaseUpdate(formData) {
  const profile = await requireAdmin();
  const id = String(formData.get('id') || '');
  const caseId = String(formData.get('caseId') || '');
  const type = String(formData.get('type') || 'note');
  if (!id) return;

  const supabase = await createClient();
  await supabase.from('case_updates').delete().eq('id', id);

  const caseNumber = await resolveCaseNumber(supabase, formData,caseId);
  await logActivity(supabase, {
    actorId: profile.id,
    action: type === 'order' ? 'order_deleted' : 'note_deleted',
    caseId,
    description: `${profile.fullName || profile.email} deleted a ${type === 'order' ? 'daily order' : 'note'} in ${caseNumber}`,
  });

  revalidateDashboardPaths(caseId);
}
