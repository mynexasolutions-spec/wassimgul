import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/supabase/dal';
import { logActivity } from '@/lib/supabase/activity';
import { uploadFileDual, deleteFileFromStorage, isAllowedFileType, MAX_FILE_BYTES } from '@/lib/storage';

export const maxDuration = 60; // Allow sufficient time for large dual uploads
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const profile = await requireAdmin();
    const formData = await request.formData();
    const caseId = String(formData.get('caseId') || '');
    const caseNumberFromForm = String(formData.get('caseNumber') || '').trim();
    const file = formData.get('file');

    if (!caseId || !(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'Please choose an image or PDF file to upload.' }, { status: 400 });
    }

    if (!isAllowedFileType(file)) {
      return NextResponse.json({ error: 'Only image (JPG, PNG, WebP, GIF, SVG) and PDF files can be uploaded.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'File is too large (25MB max).' }, { status: 400 });
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

    if (!folderDisplayName && caseNumberFromForm) {
      folderDisplayName = `Case ${caseNumberFromForm}`;
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
      console.error('Dual upload service error:', uploadError);
      return NextResponse.json({ error: uploadError?.message || 'Dual upload failed. Please try again.' }, { status: 500 });
    }

    if (!uploadResult || !uploadResult.primaryUrl) {
      return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
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
      return NextResponse.json({ error: 'Could not save the file record. Please try again.' }, { status: 500 });
    }

    let caseNumber = caseNumberFromForm;
    if (!caseNumber) {
      const { data } = await supabase.from('cases').select('case_number').eq('id', caseId).single();
      caseNumber = data?.case_number || 'a case';
    }

    await logActivity(supabase, {
      actorId: profile.id,
      action: 'file_uploaded',
      caseId,
      description: `${profile.fullName || profile.email} uploaded a file in ${caseNumber}`,
    });

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/cases');
    revalidatePath(`/dashboard/cases/${caseId}`);
    revalidatePath('/dashboard/case-files');

    return NextResponse.json({
      success: true,
      url: uploadResult.primaryUrl,
      providers: uploadResult.payloadObj?.providers,
    });
  } catch (err) {
    console.error('Upload API route error:', err);
    return NextResponse.json({ error: err?.message || 'Unauthorized or server error' }, { status: 500 });
  }
}

