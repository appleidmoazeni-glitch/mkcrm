<template>
  <main class="main-content">
    <div class="row">
      <div class="col-lg-7">
        <div class="card">
          <div class="card-header"><h5>لیست گروه ها</h5></div>
          <b-overlay :show="pLoading" opacity="0.6" rounded="lg" class="card-body p-0">
            <div class="table-responsive">
              <table class="table table-striped table-hover">
                <thead>
                <tr>
                  <th>عنوان گروه</th>
                  <th>کلید</th>
                  <th>دسترسی به پنل مدیریت</th>
                </tr>
                </thead>
                <tbody>
                <tr></tr>
                <tr v-for="group of groups" class="modal-vc-source">
                  <td data-var="title:text">{{ group.title }}</td>
                  <td data-var="key:text">{{ group.key }}</td>
                  <td data-var="admin:data" :data-value="group.admin"><span :class="group.admin ? 'text-success' : 'text-danger'">{{ group.admin ? 'دارد' : 'ندارد' }}</span></td>
                  <td data-var="id:data" :data-value="group._id" class="text-left">
                    <div class="btn-group btn-group-sm">
                      <button type="button" class="btn btn-primary" data-toggle="modal" data-target="#editGroup"><i class="fa fa-edit"></i></button>
                    </div>
                  </td>
                </tr>
                </tbody>
              </table>
            </div>
          </b-overlay>
        </div>
      </div>
      <div class="col-lg-5">
        <form @submit.prevent="onSave" id="createGroup" method="POST" class="card needs-validation" novalidate="">
          <div class="card-header"><h5>افزودن گروه کاربری</h5></div>
          <div class="card-body">
            <div class="form-group">
              <label>عنوان</label>
              <input type="text" name="title" class="form-control" placeholder="عنوان" value="" required="">
            </div>
            <div class="form-group">
              <label>کلید (با حروف انگلیسی وارد شود)</label>
              <input type="text" name="key" class="form-control" placeholder="کلید" value="" required="">
            </div>
            <div class="form-group">
              <div class="custom-control custom-switch">
                <input type="checkbox" class="custom-control-input" name="admin" id="ch_admin">
                <label class="custom-control-label" for="ch_admin">دسترسی به پنل مدیریت</label>
              </div>
            </div>
            <div class="form-group">
              <button class="btn btn-primary" type="submit">ایجاد گروه کاربری</button>
            </div>
          </div>
        </form>
      </div>
    </div>

    <div class="modal fade modal-vc" data-vars="id, title, key, admin" id="editGroup" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="exampleModalLabel">ویرایش گروه کاربری <strong data-var="title:text"></strong></h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="Close">
              <i class="ti-close"></i>
            </button>
          </div>
          <div class="modal-body">
            <form id="editForm">
              <div class="form-group">
                <label class="col-form-label">عنوان:</label>
                <input type="text" class="form-control" data-var="title:val" name="title">
              </div>
              <div class="form-group">
                <label class="col-form-label">کلید:</label>
                <input type="text" class="form-control" data-var="key:val" name="key">
              </div>
              <div class="form-group">
                <div class="custom-control custom-switch">
                  <input type="checkbox" data-var="admin:sw" class="custom-control-input" name="admin" id="chm_admin">
                  <label class="custom-control-label" for="chm_admin">دسترسی به پنل مدیریت</label>
                </div>
              </div>
              <input type="hidden" name="id" data-var="id:val">
            </form>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بستن</button>
            <button type="button" @click="onEdit" class="btn btn-primary">ویرایش</button>
          </div>
        </div>
      </div>
    </div>
  </main>

</template>

<script>
import axios from "axios";

export default {
  data(){
    return {
      groups: [],
      pLoading: true
    }
  },
  methods: {
    getGroupsList(){
      this.pLoading = true;
      axios.get('/admin/settings/groups.r').then(({data}) => {
        this.groups = data.groups;
        this.pLoading = false;
      });
    },
    onSave(){
      axios.post('/admin/settings/groups.r', $("#createGroup").serialize()).then(({data}) => {
        if( data.ok ){
          toastr['success'](data.msg);
          $("#editGroup").modal('hide');
          this.getGroupsList();
        }else{
          toastr['error'](data.error);
        }
      });
    },
    onEdit(){
      axios.put('/admin/settings/groups.r', $("#editForm").serialize()).then(({data}) => {
        if( data.ok ){
          toastr['success'](data.msg);
          $("#editGroup").modal('hide');
          this.getGroupsList();
        }else{
          toastr['error'](data.error);
        }
      });
    }
  },
  created() {
    this.getGroupsList();
  }
}
</script>

<style scoped>

</style>
