from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.deps import get_current_user
from app.models import Staff
from app.schemas.common import OssUploadResponse, UploadTokenRequest, UploadTokenResponse
from app.services.oss import generate_upload_token, upload_filename, upload_object

router = APIRouter(prefix="/api/oss", tags=["oss"])


@router.post("/upload-token", response_model=UploadTokenResponse, summary="获取 OSS 上传凭证")
def upload_token(body: UploadTokenRequest, _: Staff = Depends(get_current_user)):
    return UploadTokenResponse(**generate_upload_token(body.dir, body.filename or ""))


@router.post("/upload", response_model=OssUploadResponse, summary="上传文件到 OSS")
async def upload_file(
    dir: str = Form(...),
    filename: str = Form(""),
    file: UploadFile = File(...),
    _: Staff = Depends(get_current_user),
):
    content = await file.read()
    name = upload_filename(filename, content)
    return OssUploadResponse(**upload_object(dir, name, content, file.content_type))