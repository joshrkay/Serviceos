import {
  CreateInvoicePhotoInput,
  InvoicePhoto,
  InvoicePhotoRepository,
  JobPhotoCategory,
  isValidJobPhotoCategory,
} from './invoice-photo';
import { FileRepository, StorageProvider } from '../files/file-service';
import { ValidationError, NotFoundError } from '../shared/errors';

export interface InvoicePhotoWithUrl extends InvoicePhoto {
  downloadUrl: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export class InvoicePhotoService {
  constructor(
    private readonly repo: InvoicePhotoRepository,
    private readonly fileRepo: FileRepository,
    private readonly storage: StorageProvider,
  ) {}

  async attachPhotoToInvoice(
    tenantId: string,
    invoiceId: string,
    fileId: string,
    category: JobPhotoCategory,
    notes: string | undefined,
    takenAt: Date | undefined,
    uploadedByUserId: string,
    clientVisible?: boolean,
  ): Promise<InvoicePhoto> {
    if (!tenantId) throw new ValidationError('tenantId is required');
    if (!invoiceId) throw new ValidationError('invoiceId is required');
    if (!fileId) throw new ValidationError('fileId is required');
    if (!uploadedByUserId) throw new ValidationError('uploadedByUserId is required');
    if (!isValidJobPhotoCategory(category)) {
      throw new ValidationError(`Invalid category: ${String(category)}`);
    }

    const file = await this.fileRepo.findById(tenantId, fileId);
    if (!file) throw new NotFoundError('File', fileId);

    const input: CreateInvoicePhotoInput = {
      tenantId,
      invoiceId,
      uploadedByUserId,
      fileId,
      category,
      notes,
      takenAt,
      clientVisible,
    };
    return this.repo.create(input);
  }

  async listInvoicePhotos(tenantId: string, invoiceId: string): Promise<InvoicePhotoWithUrl[]> {
    const photos = await this.repo.listByInvoice(tenantId, invoiceId);
    return Promise.all(
      photos.map(async (photo) => {
        const file = await this.fileRepo.findById(tenantId, photo.fileId);
        if (!file) {
          return {
            ...photo,
            downloadUrl: '',
            filename: '',
            contentType: '',
            sizeBytes: 0,
          };
        }
        const downloadUrl = await this.storage.generateDownloadUrl(
          file.storageBucket,
          file.storageKey,
        );
        return {
          ...photo,
          downloadUrl,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        };
      }),
    );
  }

  async deleteInvoicePhoto(tenantId: string, invoiceId: string, photoId: string): Promise<boolean> {
    const photo = await this.repo.findById(tenantId, photoId);
    if (!photo || photo.invoiceId !== invoiceId) return false;
    return this.repo.delete(tenantId, photoId);
  }

  async setClientVisible(
    tenantId: string,
    invoiceId: string,
    photoId: string,
    clientVisible: boolean,
  ): Promise<InvoicePhoto | null> {
    const photo = await this.repo.findById(tenantId, photoId);
    if (!photo || photo.invoiceId !== invoiceId) return null;
    return this.repo.updateClientVisible(tenantId, photoId, clientVisible);
  }
}
