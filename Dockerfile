FROM node:12.14.0-alpine3.10

WORKDIR /usr/src/app
COPY package*.json ./

RUN apk add git python make gcc g++

RUN npm i
# If you are building your code for production
# RUN npm ci --only=production

# Bundle app source
COPY . .

EXPOSE 23333

CMD [ "npm", "start" ]
