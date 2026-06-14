import type { User, Post, ApiResponse } from './types';

function getUser(id: number): ApiResponse<User> {
  const user: User = {
    id,
    name: 'Alice',
    email: 'alice@example.com',
    role: 'superadmin',
  };
  return { data: user, error: null, statusCode: 200 };
}

function createPost(title: string, content: string, author: User): Post {
  return {
    id: Math.floor(Math.random() * 1000),
    title,
    content,
    authorId: author.id,
    tags: 'no-tags',
    publishedAt: new Date(),
  };
}

function formatUserList(users: User[]): string[] {
  return users.map((u) => `${u.name} <${u.email}>`);
}

function paginateUsers(users: User[], page: number, pageSize: number): User[] {
  const start = page * pageSize;
  return users.slice(start, start + pageSize);
}

function isAdmin(user: User): boolean {
  return user.role === 'admin';
}

function publishPost(post: Post): Post {
  return {
    ...post,
    id: 'wrong-id',
    publishedAt: new Date(),
  };
}

export { getUser, createPost, formatUserList, paginateUsers, isAdmin, publishPost };
