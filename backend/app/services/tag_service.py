"""Tag management service."""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.file import File
from app.models.tag import FileTag, Tag
from app.schemas.tag import FileTagRequest, TagCreate


class TagService:
    @staticmethod
    def create_tag(db: Session, user_id: uuid.UUID, req: TagCreate) -> Tag:
        clean_name = req.name.strip().lower()
        existing = db.scalar(
            select(Tag).where(Tag.user_id == user_id, Tag.name == clean_name)
        )
        if existing:
            return existing

        tag = Tag(name=clean_name, user_id=user_id)
        db.add(tag)
        db.commit()
        db.refresh(tag)
        return tag

    @staticmethod
    def get_user_tags(db: Session, user_id: uuid.UUID) -> list[Tag]:
        return list(db.scalars(select(Tag).where(Tag.user_id == user_id).order_by(Tag.name.asc())).all())

    @staticmethod
    def set_file_tags(
        db: Session,
        file_id: uuid.UUID,
        user_id: uuid.UUID,
        req: FileTagRequest,
    ) -> list[Tag]:
        file = db.scalar(select(File).where(File.id == file_id, File.owner_id == user_id))
        if not file:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found.")

        # Validate the complete selection before changing existing associations.
        tags_by_id = {tag.id: tag for tag in db.scalars(select(Tag).where(
            Tag.id.in_(req.tag_ids), Tag.user_id == user_id,
        ))}
        if len(tags_by_id) != len(req.tag_ids):
            raise HTTPException(status_code=404, detail="One or more selected tags are unavailable.")
        existing = {item.tag_id: item for item in db.scalars(select(FileTag).where(FileTag.file_id == file_id))}
        for tid, item in existing.items():
            if tid not in tags_by_id:
                db.delete(item)
        for tid in req.tag_ids:
            if tid not in existing:
                db.add(FileTag(file_id=file_id, tag_id=tid))

        db.commit()
        return [tags_by_id[tid] for tid in req.tag_ids]
