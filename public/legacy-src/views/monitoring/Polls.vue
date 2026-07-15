<template>
  <main class="main-content">
    <div class="card">
      <div class="card-header">
        <h5>نظرسنجی ها</h5>
        <div class="items form-inline">
          <button class="btn btn-success mr-2" type="button"><i class="fa fa-file-o ml-2"></i><span>نظرسنجی جدید</span></button>
        </div>
      </div>
      <div class="card-body p-0 table-orders">
        <b-skeleton-table v-if="loading.data" :rows="5" :columns="4" :table-props="{ bordered: true, striped: true }"></b-skeleton-table>
        <div v-else class="card-scroll h-100">
          <div class="table-responsive">
            <table :class="['table table-hover']" class="table table-hover" width="100%">
              <thead>
              <tr>
                <th>عنوان هدف</th>
                <th>کلید</th>
                <th>تاریخ ایجاد</th>
                <th></th>
              </tr>
              </thead>
              <tbody>
              <tr>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
              </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <div class="modal fade" id="createPoll" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">افزودن نظرسنجی جدید</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="col-form-label">کلید (لاتین):</label>
              <input type="text" class="form-control" name="key">
            </div>
            <div class="form-group">
              <label class="col-form-label">عنوان:</label>
              <input type="text" class="form-control" name="title">
            </div>
            <div class="form-group">
              <label class="col-form-label">توضیحات:</label>
              <textarea class="form-control" name="description"></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button type="button" class="btn btn-primary">ثبت</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
<script type="ts">
export default {
  data(){return {
    loading: {data: false}
  }}
}
</script>
<style scoped>
.items{
  /* margin-top: 10px; */
  position: absolute;
  left: 11px;
  top: 8px;
}
</style>
