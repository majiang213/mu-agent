const request = require('supertest');
const app = require('./server');

describe('TODO API', () => {
  it('GET /todos returns list', async () => {
    const res = await request(app).get('/todos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /todos creates item', async () => {
    const res = await request(app).post('/todos').send({ text: 'Test task' });
    expect(res.status).toBe(201);
    expect(res.body.text).toBe('Test task');
  });

  it('PUT /todos/:id updates item', async () => {
    const res = await request(app).put('/todos/1').send({ done: true });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
  });

  it('DELETE /todos/:id removes item', async () => {
    const res = await request(app).delete('/todos/1');
    expect(res.status).toBe(200);

    const listRes = await request(app).get('/todos');
    const ids = listRes.body.map((t) => t.id);
    expect(ids).not.toContain(1);
  });

  it('DELETE /todos/:id returns 404 for missing item', async () => {
    const res = await request(app).delete('/todos/9999');
    expect(res.status).toBe(404);
  });
});
