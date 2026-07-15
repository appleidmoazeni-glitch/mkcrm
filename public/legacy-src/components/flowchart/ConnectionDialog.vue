<template>
  <div id="Flowchart-Modal" class="modal" tabindex="-1" v-if="visible">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">ویرایش ارتباط</h5>
          <button type="button" class="close" data-dismiss="modal" aria-label="Close">
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div class="modal-body">
          <label for="name">نام ارتباط</label>
          <input id="name" class="form-control" v-model="connectionForm.name"/>
          <label for="type">نوع ارتباط</label>
          <select id="type" class="form-control" v-model="connectionForm.type">
            <option :key="'connection-type-' + item.id"
                    v-for="item in [ { name: 'موافق', id: 'pass' }, { name: 'مخالف', id: 'reject' } ]"
                    :value="item.id">
              {{item.name}}
            </option>
          </select>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary mr-1" data-dismiss="modal" @click="handleClickCancelSaveConnection">لغو</button>
          <button class="btn btn-primary" data-dismiss="modal" @click="handleClickSaveConnection">ذخیره</button>
        </div>
      </div>
    </div>
  </div>
</template>
<script>
  export default {
    props: {
      visible: {
        type: Boolean,
        default: false,
      },
      connection: {
        type: Object,
        default: null,
      },
    },
    data() {
      return {
        connectionForm: {
          type: null,
          sourceId: null,
          sourcePosition: null,
          destinationId: null,
          destinationPosition: null,
          name: null,
          expression: null,
        },
      };
    },
    methods: {
      async handleClickSaveConnection() {
        this.$emit('update:visible', false);
        this.$emit('update:connection', Object.assign(this.connection, {
          name: this.connectionForm.name,
          type: this.connectionForm.type,
          expression: this.connectionForm.expression,
        }));
      },
      async handleClickCancelSaveConnection() {
        this.$emit('update:visible', false);
      },
    },
    watch: {
      connection: {
        immediate: true,
        handler(val) {
          if (!val) { return; }
          this.connectionForm.id = val.id;
          this.connectionForm.type = val.type;
          this.connectionForm.name = val.name;
          this.connectionForm.expression = val.expression;
        },
      }
    },
  };
</script>
